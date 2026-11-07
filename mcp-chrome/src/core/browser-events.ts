import { sanitizeUrl } from '../tools/network-sanitizer.js'
import { getErrorSource } from './errors.js'

export type BytePayload = { encoding: 'utf8' | 'base64'; data: string }
export type BrowserEventAction = 'dialog' | 'networkCapture' | 'route' | 'httpAuth' | 'download' | 'read'
export type BrowserEventRead = {
    type: 'dialog' | 'download' | 'network'
    view?: 'summary' | 'details' | 'requestBody' | 'responseBody' | 'stream' | 'paused' | 'auth'
    ref?: string
    limit?: number
    clear?: boolean
    urlPattern?: string
}
export type EventCommand = Record<string, unknown> & { op?: string; ref?: string }
interface NativeEvent extends Record<string, unknown> {
    requestId: string
    request: { url: string; method?: string } & Record<string, unknown>
    response?: { payloadData?: string } & Record<string, unknown>
    frame?: { id?: string; parentId?: string }
    frameId?: string
    loaderId?: string
    networkId?: string
    url: string
    data?: string
    timestamp?: number
}
type NativeSend = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>
type Entry = Record<string, unknown> & { ref: string; kind: string; timestamp: number; sessionId?: string }
type Pause = Entry & {
    requestId: string
    state: string
    abortReason?: string
    timer?: ReturnType<typeof setTimeout>
    bodyRead?: Promise<void>
}
type Request = Entry & { requestId: string; hop: number; url: string; request: Record<string, unknown>; state: string }
const MAX_ENTRIES = 500
const MAX_PENDING = 64
const MAX_METADATA = 16 * 1024 * 1024
const MAX_BYTES = 48 * 1024 * 1024
const MAX_BODY = 16 * 1024 * 1024
const MAX_MESSAGE = 64 * 1024
const TTL = 5 * 60_000
const PAUSE_TTL = 30_000

export function eventRefTarget(ref: string): { backend: string; targetId: string } {
    const parts = ref.split(':')
    if (parts.length !== 7 || parts[0] !== 'be') {
        throw new Error('Invalid browser event ref')
    }
    return { backend: parts[1], targetId: decodeURIComponent(parts[2]) }
}

function matches(value: string, pattern = '*'): boolean {
    if (!pattern.includes('*') && !pattern.includes('?')) {
        return value.includes(pattern)
    }
    let position = 0
    let index = 0
    let star = -1
    let restart = 0
    while (position < value.length) {
        if (pattern[index] === '?' || pattern[index] === value[position]) {
            ++position
            ++index
        } else if (pattern[index] === '*') {
            star = index++
            restart = position
        } else if (star >= 0) {
            index = star + 1
            position = ++restart
        } else {
            return false
        }
    }
    while (pattern[index] === '*') {
        ++index
    }
    return index === pattern.length
}
function bytes(payload: BytePayload): number {
    if (payload.encoding === 'utf8') {
        return new TextEncoder().encode(payload.data).length
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.data)) {
        throw new Error('Invalid base64 payload')
    }
    return (payload.data.length / 4) * 3 - (payload.data.endsWith('==') ? 2 : payload.data.endsWith('=') ? 1 : 0)
}
function base64(payload: BytePayload): string {
    if (bytes(payload) >= MAX_BODY) {
        throw new Error('Payload exceeds the 16 MiB event body budget')
    }
    if (payload.encoding === 'base64') {
        return payload.data
    }
    const data = new TextEncoder().encode(payload.data)
    let binary = ''
    for (let i = 0; i < data.length; i += 8192) {
        binary += String.fromCharCode(...data.subarray(i, i + 8192))
    }
    return btoa(binary)
}
function bounded(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
        return value.slice(0, MAX_MESSAGE)
    }
    if (!value || typeof value !== 'object') {
        return value
    }
    if (depth >= 8) {
        return '[metadata depth limit]'
    }
    if (Array.isArray(value)) {
        return value.slice(0, 1000).map((v) => bounded(v, depth + 1))
    }
    const result = Object.fromEntries(
        Object.entries(value)
            .slice(0, 1000)
            .map(([key, v]) => [
                key,
                /^(?:postData|postDataEntries)$/.test(key)
                    ? '[read original requestBody by ref]'
                    : bounded(v, depth + 1),
            ])
    )
    if (depth === 0 && new TextEncoder().encode(JSON.stringify(result)).length > 128 * 1024) {
        const retained = Object.fromEntries(
            Object.entries(result).filter(
                ([key, v]) => typeof v !== 'object' && !['data', 'message', 'defaultPrompt'].includes(key)
            )
        )
        return {
            ...retained,
            metadataTruncated: true,
            ...(result.request
                ? {
                      request: {
                          url: (result.request as Record<string, unknown>).url,
                          method: (result.request as Record<string, unknown>).method,
                      },
                  }
                : {}),
            ...(result.response
                ? {
                      response: {
                          status: (result.response as Record<string, unknown>).status,
                          payloadData: (result.response as Record<string, unknown>).payloadData,
                          opcode: (result.response as Record<string, unknown>).opcode,
                      },
                  }
                : {}),
            ...(typeof result.data === 'string' && !result.response ? { data: result.data } : {}),
            ...(typeof result.message === 'string' ? { message: result.message.slice(0, 16 * 1024) } : {}),
            ...(typeof result.defaultPrompt === 'string'
                ? { defaultPrompt: result.defaultPrompt.slice(0, 16 * 1024) }
                : {}),
        }
    }
    return result
}
function redact(value: unknown, key = ''): unknown {
    if (/^(?:authorization|proxy-authorization|cookie|set-cookie|cookieLine|password|username)$/i.test(key)) {
        return '[REDACTED]'
    }
    if (Array.isArray(value)) {
        return value.map((v) => redact(v))
    }
    if (value && typeof value === 'object' && 'name' in value && 'value' in value) {
        return { ...value, value: redact(value.value, String(value.name)) }
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([k]) => k !== 'timer' && k !== 'bodyRead')
                .map(([k, v]) => [k, redact(v, k)])
        )
    }
    if (typeof value === 'string' && /^(?:request|response)?headersText$/i.test(key)) {
        return value
            .replace(
                /^(?<method>[A-Z]+)\s+(?<url>\S+)\s+(?<protocol>HTTP\/[^\r\n]+)/,
                (_line, method: string, url: string, protocol: string) => `${method} ${redact(url, 'url')} ${protocol}`
            )
            .replace(
                /^(?<h>authorization|proxy-authorization|cookie|set-cookie):[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gim,
                '$<h>: [REDACTED]'
            )
            .replace(
                /^(?<header>(?:location|content-location|referer|referrer|origin):[ \t]*)(?<url>[^\r\n]*)/gim,
                (_line, header: string, url: string) => `${header}${redact(url, 'url')}`
            )
    }
    if (
        typeof value === 'string' &&
        /^(?:url|documentURL|origin|location|content-location|referer|referrer)$/i.test(key)
    ) {
        const sanitized = sanitizeUrl(value).url
        return sanitized.replace(/^(?<scheme>(?:https?|wss?):\/\/)[^/@]+@/i, '$<scheme>[REDACTED]@')
    }
    return value
}

/** Native event state is shared by CDP and chrome.debugger; it never re-fetches a URL. */
export class BrowserEventController {
    private sequence = 0
    private entries = new Map<string, Entry>()
    private requests = new Map<string, Request[]>()
    private extras = new Map<string, { request: unknown[]; response: unknown[] }>()
    private pauses = new Map<string, Pause>()
    private bodies = new Map<string, BytePayload>()
    private bodyBytes = 0
    private dropped = 0
    private evicted = 0
    private dialogWatching = true
    private rawAuthentication = false
    private dialog?: Entry
    private dialogWaiters = new Set<(error: Error) => void>()
    private routes = new Map<string, { urlPattern: string; stage: string; raw?: boolean }>()
    private credentials?: { source: string; origin: string; realm?: string; username: string; password: string }
    private challenged = new Set<string>()
    private capture = new Set<string>()
    private downloading = false
    private downloadPattern = '*'
    private fetchEnabled = false
    private fetchConfig: Promise<unknown> = Promise.resolve()
    private active = true
    private documentRevision = 0
    private downloadBodies = new Map<string, Array<{ ref: string; frameId?: string; url: string }>>()
    private downloadWaiters = new Set<() => void>()
    private cleanupFailures: Array<{
        timestamp: number
        phase: string
        error: string
        targetId: string
        owner: string
        sessionGeneration: string
        nativeSessionId?: string
        requestId?: string
        ref?: string
    }> = []

    constructor(
        readonly identity: {
            backend: string
            targetId: string
            owner: string
            generation: string
            nativeSessionId?: string
        },
        private send: NativeSend
    ) {}

    handle(method: string, raw: unknown, sessionId?: string): void {
        if (!this.active) {
            return
        }
        const p = raw as NativeEvent
        if (method === 'Page.javascriptDialogOpening') {
            if (!this.dialogWatching) {
                return
            }
            this.dialog = this.make('dialog', { ...p, sessionId, state: 'pending' })
            const error = this.dialogError()
            for (const reject of this.dialogWaiters) {
                reject(error)
            }
        } else if (method === 'Page.javascriptDialogClosed' && this.dialog) {
            Object.assign(this.dialog, { state: 'closed', result: p.result, userInput: p.userInput })
            this.dialog = undefined
        } else if (
            method === 'Page.frameNavigated' &&
            !p.frame?.parentId &&
            sessionId === this.identity.nativeSessionId
        ) {
            this.documentRevision++
            void this.abortPending('navigation')
            this.challenged.clear()
            if (this.dialog) {
                this.dialog.state = 'invalidated'
                this.dialog = undefined
            }
        } else if (method === 'Page.frameNavigated') {
            for (const pause of this.pauses.values()) {
                if (
                    (p.frame?.id && pause.frameId === p.frame.id) ||
                    (sessionId !== this.identity.nativeSessionId && pause.sessionId === sessionId)
                ) {
                    void this.abortOne(pause, 'frame navigation')
                }
            }
        } else if (method === 'Network.requestWillBeSent') {
            const key = this.key(p.requestId, sessionId)
            const hops = this.requests.get(key) ?? []
            if (p.redirectResponse && hops.length) {
                Object.assign(hops.at(-1)!, {
                    response: bounded(p.redirectResponse),
                    state: 'redirected',
                    extraExpected: p.redirectHasExtraInfo === true,
                })
            }
            const entry = this.make('request', {
                requestId: p.requestId,
                hop: hops.length,
                url: p.request.url,
                request: p.request,
                frameId: p.frameId,
                loaderId: p.loaderId,
                type: p.type,
                sessionId,
                state: 'pending',
                protocolTimestamp: p.timestamp,
            }) as Request
            hops.push(entry)
            this.requests.set(key, hops)
            this.bindExtras(key)
        } else if (method === 'Network.requestWillBeSentExtraInfo' || method === 'Network.responseReceivedExtraInfo') {
            const key = this.key(p.requestId, sessionId)
            const extras = this.extras.get(key) ?? { request: [], response: [] }
            const queue = method.endsWith('requestWillBeSentExtraInfo') ? extras.request : extras.response
            const queued = [...this.extras.values()].reduce(
                (count, value) => count + value.request.length + value.response.length,
                0
            )
            if (queued < MAX_ENTRIES) {
                queue.push(bounded(p))
            } else {
                this.dropped++
            }
            this.extras.set(key, extras)
            this.bindExtras(key)
        } else if (method === 'Network.responseReceived') {
            const request = this.latest(p.requestId, sessionId)
            if (request) {
                Object.assign(request, {
                    response: bounded(p.response),
                    extraExpected: p.hasExtraInfo === true,
                    ...(JSON.stringify(p.response) !== JSON.stringify(bounded(p.response))
                        ? { metadataTruncated: true }
                        : {}),
                })
                this.bindExtras(this.key(p.requestId, sessionId))
            }
        } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
            const request = this.latest(p.requestId, sessionId)
            if (request) {
                Object.assign(request, {
                    state: method.endsWith('loadingFinished') ? 'finished' : 'failed',
                    errorText: p.errorText,
                    encodedDataLength: p.encodedDataLength,
                })
                if (this.capture.has('body') && request.state === 'finished') {
                    void this.readBody(request, 'responseBody').catch((e) => {
                        request.bodyError = this.failure(e)
                    })
                }
            }
        } else if (this.capture.has('stream') && /^Network\.(?:webSocket|eventSource)/.test(method)) {
            const data = p.response?.payloadData ?? p.data
            const dataText = typeof data === 'string' ? data : undefined
            const encoded = dataText === undefined ? undefined : new TextEncoder().encode(dataText)
            const truncated = (encoded?.length ?? 0) > MAX_MESSAGE
            const message = truncated ? new TextDecoder().decode(encoded!.subarray(0, MAX_MESSAGE)) : dataText
            this.make('stream', {
                ...p,
                response: p.response ? { ...p.response, payloadData: message } : undefined,
                data: message,
                truncated,
                originalBytes: encoded?.length,
                protocolTimestamp: p.timestamp,
                nativeMethod: method,
                direction: method.includes('Sent')
                    ? 'sent'
                    : method.includes('Received') || method.includes('MessageReceived')
                      ? 'received'
                      : 'lifecycle',
                sessionId,
                requestRef: this.latest(p.requestId, sessionId)?.ref,
                sequence: this.sequence + 1,
            })
        } else if (method === 'Fetch.requestPaused') {
            void this.onPaused(p, sessionId).catch((e) => {
                this.recordCleanupFailure(e, method, p.requestId, sessionId)
            })
        } else if (method === 'Fetch.authRequired') {
            void this.onAuth(p, sessionId).catch((e) => {
                this.recordCleanupFailure(e, method, p.requestId, sessionId)
            })
        } else if (method === 'Page.downloadWillBegin' || method === 'Browser.downloadWillBegin') {
            if (!this.downloading || !matches(p.url, this.downloadPattern)) {
                return
            }
            const existing = [...this.entries.values()].find((e) => e.kind === 'download' && e.guid === p.guid)
            if (existing) {
                return
            }
            const candidates = p.frameId ? (this.downloadBodies.get(p.frameId) ?? []) : []
            const captured = candidates.length === 1 && candidates[0].url === p.url ? candidates[0] : undefined
            const entry = this.make('download', {
                ...p,
                sessionId,
                state: 'inProgress',
                artifact: captured ? 'available' : 'unavailable',
                bodyRef: captured?.ref,
                artifactReason: captured
                    ? undefined
                    : candidates.length > 1
                      ? 'Multiple original response candidates in this frame; native GUID cannot be assigned safely'
                      : 'Original response unavailable (blob, Save As, browser security, or uncaptured response)',
            })
            if (p.frameId && (captured || candidates.length > 1)) {
                this.downloadBodies.delete(p.frameId)
            }
            void entry
            this.notifyDownloads()
        } else if (method === 'Page.downloadProgress' || method === 'Browser.downloadProgress') {
            const entry = [...this.entries.values()].find((e) => e.kind === 'download' && e.guid === p.guid)
            if (entry) {
                Object.assign(entry, { ...p })
                this.notifyDownloads()
            }
        }
    }

    assertNativeReady(): void {
        if (this.dialog && ['pending', 'resolving', 'unknown'].includes(String(this.dialog.state))) {
            throw this.dialogError(false)
        }
    }

    async race<T>(operation: Promise<T>): Promise<T> {
        this.dialogWatching = true
        if (this.dialog?.state === 'pending') {
            void operation.catch(() => {})
            throw this.dialogError()
        }
        let rejectDialog: (error: Error) => void = () => {}
        const dialog = new Promise<never>((_, reject) => {
            rejectDialog = reject
            this.dialogWaiters.add(reject)
        })
        try {
            return await Promise.race([operation, dialog])
        } finally {
            this.dialogWaiters.delete(rejectDialog)
        }
    }

    async command(
        action: BrowserEventAction,
        command: EventCommand,
        signal?: AbortSignal
    ): Promise<Record<string, unknown>> {
        signal?.throwIfAborted()
        if (!this.active) {
            throw new Error('Browser event session is closed')
        }
        if (action === 'read') {
            return this.read(command as unknown as BrowserEventRead)
        }
        const op = command.op
        if (action === 'dialog') {
            if (op === 'watch') {
                this.dialogWatching = true
                await this.send('Page.enable')
                return this.status()
            }
            if (op === 'stop') {
                this.dialogWatching = false
                return { ...this.status(), stopped: true, pending: this.dialog?.ref ?? null }
            }
            const entry = this.require(command.ref, 'dialog')
            if (entry !== this.dialog || !['pending', 'resolving'].includes(String(entry.state))) {
                throw new Error('Dialog is no longer pending')
            }
            if (entry.state === 'resolving') {
                throw new Error('Dialog handling already dispatched; outcome pending')
            }
            entry.state = 'resolving'
            try {
                await this.send(
                    'Page.handleJavaScriptDialog',
                    { accept: op === 'accept', ...(command.text !== undefined ? { promptText: command.text } : {}) },
                    entry.sessionId
                )
                if (entry.state === 'resolving') {
                    entry.state = 'handled'
                }
                if (this.dialog === entry) {
                    this.dialog = undefined
                }
            } catch (e) {
                if (entry.state === 'resolving') {
                    entry.state = 'unknown'
                }
                throw e
            }
            return { ...this.status(), dialog: redact(entry) }
        }
        if (action === 'networkCapture') {
            if (op === 'start') {
                this.capture = new Set((command.include as string[]) ?? [])
                await this.send('Network.enable', {
                    maxTotalBufferSize: MAX_BYTES,
                    maxResourceBufferSize: MAX_BODY,
                    maxPostDataSize: MAX_BODY,
                })
            } else {
                this.capture.clear()
            }
            return this.status()
        }
        if (action === 'route') {
            if (op === 'add') {
                if (this.routes.size >= 100) {
                    throw new Error('Route limit reached (100); remove unused rules')
                }
                const rule = this.make('route', { urlPattern: command.urlPattern, stage: command.stage ?? 'Request' })
                this.routes.set(rule.ref, {
                    urlPattern: String(command.urlPattern),
                    stage: String(command.stage ?? 'Request'),
                })
                try {
                    await this.configureFetch()
                } catch (e) {
                    this.routes.delete(rule.ref)
                    throw e
                }
                return { ...this.status(), rule: redact(rule) }
            }
            if (op === 'remove') {
                this.require(command.ref, 'route')
                this.routes.delete(command.ref!)
                await Promise.all(
                    [...this.pauses.values()]
                        .filter((pause) => pause.ruleRef === command.ref)
                        .map((pause) => this.abortOne(pause, 'route removed'))
                )
                await this.configureFetch()
                return this.status()
            }
            return this.resolvePause(command)
        }
        if (action === 'httpAuth') {
            if (op === 'set') {
                const scope = command.scope as { source: string; origin: string; realm?: string }
                const origin = new URL(scope.origin).origin
                if (origin !== scope.origin) {
                    throw new Error('Authentication scope must be an exact origin without path or credentials')
                }
                this.credentials = {
                    ...scope,
                    origin,
                    username: String(command.username),
                    password: String(command.password),
                }
            } else {
                this.credentials = undefined
                await this.abortPending('authentication cleared', 'auth')
            }
            await this.configureFetch()
            return this.status()
        }
        if (action === 'download') {
            if (op === 'watch') {
                this.downloading = true
                this.downloadPattern = String(command.urlPattern ?? '*')
                await this.send('Page.enable')
                await this.configureFetch()
                return this.status()
            }
            if (op === 'stop') {
                this.downloading = false
                await this.abortPending('download observation stopped', 'download-capture')
                await this.configureFetch()
                return this.status()
            }
            const entry = this.require(command.ref, 'download')
            if (op === 'wait') {
                return this.waitDownload(entry, Number(command.timeout ?? 30_000), signal)
            }
            if (entry.state !== 'completed') {
                throw new Error(`Download state is ${entry.state}; original file is not complete`)
            }
            const body = typeof entry.bodyRef === 'string' ? this.bodies.get(entry.bodyRef) : undefined
            if (!body) {
                throw new Error(String(entry.artifactReason ?? 'Original download bytes expired or were evicted'))
            }
            return { ...this.status(), download: redact(entry), payload: body, bytes: bytes(body) }
        }
        throw new Error('Unsupported browser event action')
    }

    async abortPending(reason: string, kind?: string): Promise<void> {
        await Promise.all(
            [...this.pauses.values()].filter((p) => !kind || p.kind === kind).map((p) => this.abortOne(p, reason))
        )
    }

    async suspend(reason: string): Promise<Record<string, unknown>> {
        this.credentials = undefined
        this.rawAuthentication = false
        this.dialogWatching = false
        this.capture.clear()
        this.downloading = false
        await this.abortPending(reason)
        const unresolved = [...this.pauses.values()]
        if (unresolved.length) {
            return {
                ...this.status(),
                suspended: false,
                reason,
                unresolved: unresolved.map((p) => ({ ref: p.ref, state: p.state, cleanupError: p.cleanupError })),
            }
        }
        this.routes.clear()
        await this.configureFetch()
        return { ...this.status(), suspended: true, reason }
    }

    async dispose(reason: string): Promise<Record<string, unknown>> {
        const result = await this.suspend(reason)
        if (result.suspended === false) {
            throw Object.assign(new Error('Browser event cleanup outcome unknown'), { context: result })
        }
        this.active = false
        this.entries.clear()
        this.bodies.clear()
        this.requests.clear()
        this.extras.clear()
        this.challenged.clear()
        this.downloadBodies.clear()
        this.cleanupFailures = []
        this.bodyBytes = 0
        for (const reject of this.dialogWaiters) {
            reject(new Error(reason))
        }
        this.dialogWaiters.clear()
        this.notifyDownloads()
        return result
    }

    async rawFetch(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        if (method === 'Fetch.enable') {
            const patterns = params.patterns as Array<{ urlPattern?: string; requestStage?: string }> | undefined
            for (const [key, rule] of this.routes) {
                if (rule.raw) {
                    this.routes.delete(key)
                }
            }
            if ((patterns?.length ?? 1) + this.routes.size > 100) {
                throw new Error('Route limit reached (100)')
            }
            const rule = this.make('route', { raw: true })
            for (const [index, p] of (patterns ?? [{}]).entries()) {
                this.routes.set(`${rule.ref}/${index}`, {
                    urlPattern: p.urlPattern ?? '*',
                    stage: p.requestStage ?? 'Request',
                    raw: true,
                })
            }
            this.rawAuthentication = params.handleAuthRequests === true
            this.fetchEnabled = true
            const combined = [...this.routes.values()].map((rule) => ({
                urlPattern: rule.urlPattern,
                requestStage: rule.stage,
            }))
            if (this.downloading) {
                combined.push({ urlPattern: this.downloadPattern, requestStage: 'Response' })
            }
            if (this.credentials) {
                combined.push({ urlPattern: '*', requestStage: 'Request' })
            }
            return this.send(method, {
                ...params,
                patterns: combined,
                handleAuthRequests: !!this.credentials || this.rawAuthentication,
            })
        }
        if (method === 'Fetch.disable') {
            await this.abortPending('raw Fetch.disable')
            if (this.pauses.size) {
                throw new Error('Fetch cleanup incomplete; debugger remains attached')
            }
            this.routes.clear()
            this.credentials = undefined
            this.rawAuthentication = false
            this.downloading = false
            this.fetchEnabled = false
            return this.send(method, params)
        }
        const candidates = [...this.pauses.values()].filter((p) => p.requestId === params.requestId)
        if (candidates.length > 1) {
            throw new Error('Ambiguous native Fetch requestId across sessions; use its observed ref through route')
        }
        const entry = candidates[0]
        if (!entry) {
            throw new Error('Fetch request is not pending under this page/session owner')
        }
        if (method === 'Fetch.getResponseBody') {
            return this.send(method, params, entry.sessionId)
        }
        if (
            ![
                'Fetch.continueRequest',
                'Fetch.continueResponse',
                'Fetch.fulfillRequest',
                'Fetch.failRequest',
                'Fetch.continueWithAuth',
            ].includes(method)
        ) {
            throw new Error('Unsupported Fetch command; stream consumption is not supported')
        }
        if (entry.state !== 'pending') {
            throw new Error('Fetch operation already dispatched')
        }
        entry.state = 'resolving'
        clearTimeout(entry.timer)
        try {
            const result = await this.send(method, params, entry.sessionId)
            entry.state = 'resolved'
            return result
        } catch (e) {
            this.nativeFailure(entry, e)
            throw e
        } finally {
            if (entry.state === 'resolved') {
                this.pauses.delete(entry.ref)
            }
        }
    }

    private make(kind: string, fields: Record<string, unknown> = {}): Entry {
        this.sweep()
        const ref = [
            'be',
            this.identity.backend,
            encodeURIComponent(this.identity.targetId),
            this.identity.generation,
            kind,
            ++this.sequence,
            crypto.randomUUID(),
        ].join(':')
        const boundedFields = bounded(fields) as Record<string, unknown>
        const entry = {
            ...boundedFields,
            ...(JSON.stringify(fields) !== JSON.stringify(boundedFields) ? { metadataTruncated: true } : {}),
            ref,
            kind,
            timestamp: Date.now(),
            targetId: this.identity.targetId,
            documentRevision: this.documentRevision,
        } as Entry
        this.entries.set(ref, entry)
        while (
            this.entries.size > MAX_ENTRIES ||
            new TextEncoder().encode(
                JSON.stringify([...this.entries.values()], (key, value) =>
                    key === 'timer' || key === 'bodyRead' ? undefined : value
                )
            ).length > MAX_METADATA
        ) {
            const oldest = [...this.entries.values()].find(
                (e) =>
                    !this.pauses.has(e.ref) &&
                    e !== this.dialog &&
                    ![...this.routes.keys()].some((key) => key === e.ref || key.startsWith(e.ref + '/'))
            )
            if (!oldest) {
                this.dropped++
                break
            }
            this.remove(oldest.ref)
        }
        return entry
    }

    private remove(ref: string): void {
        this.entries.delete(ref)
        for (const key of [ref, `${ref}/request`]) {
            const body = this.bodies.get(key)
            if (body) {
                this.bodyBytes -= bytes(body)
                this.bodies.delete(key)
            }
        }
        this.evicted++
    }

    private sweep(): void {
        for (const e of this.entries.values()) {
            if (
                Date.now() - e.timestamp > TTL &&
                !this.pauses.has(e.ref) &&
                e !== this.dialog &&
                ![...this.routes.keys()].some((key) => key === e.ref || key.startsWith(e.ref + '/'))
            ) {
                this.remove(e.ref)
            }
        }
        for (const [key, hops] of this.requests) {
            if (!hops.some((h) => this.entries.has(h.ref))) {
                this.requests.delete(key)
                this.extras.delete(key)
            }
        }
        while (this.extras.size > MAX_ENTRIES) {
            this.extras.delete(this.extras.keys().next().value!)
            this.dropped++
        }
    }

    private require(ref: string | undefined, kind?: string): Entry {
        this.sweep()
        const entry = ref && this.entries.get(ref)
        if (!this.active || !entry || (kind && entry.kind !== kind)) {
            throw new Error('Browser event ref expired, evicted, or belongs to another owner/page/session')
        }
        return entry
    }

    private saveBody(ref: string, payload: BytePayload): void {
        const length = bytes(payload)
        if (length >= MAX_BODY) {
            throw new Error('Original body exceeds the 16 MiB event body budget')
        }
        while (this.bodyBytes + length > MAX_BYTES && this.bodies.size) {
            const oldest = this.bodies.keys().next().value!
            this.bodyBytes -= bytes(this.bodies.get(oldest)!)
            this.bodies.delete(oldest)
            this.evicted++
        }
        const previous = this.bodies.get(ref)
        if (previous) {
            this.bodyBytes -= bytes(previous)
        }
        this.bodies.set(ref, payload)
        this.bodyBytes += length
    }

    private key(requestId: string, sessionId?: string): string {
        return `${sessionId ?? ''}\0${requestId}`
    }

    private latest(requestId: string | undefined, sessionId?: string): Request | undefined {
        if (requestId === undefined) {
            return undefined
        }
        return this.requests.get(this.key(requestId, sessionId))?.at(-1)
    }

    private nativeFailure(entry: Pause, error: unknown): void {
        const context = (error as { context?: { nativeCode?: number; actionExecuted?: unknown; method?: string } })
            ?.context
        const message = this.failure(error)
        let code = context?.nativeCode
        let nativeMessage: string | undefined
        if (code !== undefined && context?.method?.startsWith('Fetch.') && message.startsWith(`${context.method}: `)) {
            nativeMessage = message.slice(context.method.length + 2)
        }
        if (code === undefined) {
            try {
                const native = JSON.parse(message) as { code?: number; message?: string } | null
                code = native?.code
                nativeMessage = native?.message
            } catch {
                /* Native errors can also use plain text. */
            }
        }
        const fromPage = getErrorSource(error) === 'page'
        clearTimeout(entry.timer)
        entry.error = message
        if (!fromPage && code === -32602 && nativeMessage === 'Invalid InterceptionId.') {
            entry.state = 'expired'
            entry.reason = 'Native interception no longer exists'
            this.pauses.delete(entry.ref)
            return
        }
        const refused = !fromPage && (context?.actionExecuted === false || [-32601, -32602].includes(code ?? 0))
        entry.state = refused ? 'pending' : 'unknown'
        const remaining = entry.timestamp + PAUSE_TTL - Date.now()
        if (refused && remaining > 0) {
            entry.timer = setTimeout(() => {
                void this.abortOne(entry, 'pause timeout after native refusal')
            }, remaining)
        }
    }

    private failure(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }

    private recordCleanupFailure(
        error: unknown,
        phase: string,
        requestId?: string,
        sessionId?: string,
        ref?: string
    ): void {
        const pause = ref
            ? undefined
            : [...this.pauses.values()].find((entry) => entry.requestId === requestId && entry.sessionId === sessionId)
        this.cleanupFailures.push({
            timestamp: Date.now(),
            phase,
            error: this.failure(error),
            targetId: this.identity.targetId,
            owner: this.identity.owner,
            sessionGeneration: this.identity.generation,
            nativeSessionId: sessionId ?? this.identity.nativeSessionId,
            requestId,
            ref: ref ?? pause?.ref,
        })
        this.cleanupFailures = this.cleanupFailures.slice(-20)
    }

    private bindExtras(key: string): void {
        const hops = this.requests.get(key)
        const extras = this.extras.get(key)
        if (!hops || !extras) {
            return
        }
        for (const hop of hops) {
            if (hop.extraExpected === undefined) {
                break
            }
            if (hop.extraExpected && !hop.requestExtraInfo && extras.request.length) {
                hop.requestExtraInfo = extras.request.shift()
            }
            if (hop.extraExpected && !hop.responseExtraInfo) {
                if (!extras.response.length) {
                    break
                }
                hop.responseExtraInfo = extras.response.shift()
            }
        }
    }

    private dialogError(actionExecuted: 'unknown' | false = 'unknown'): Error {
        const message =
            'Native operation is blocked by a JavaScript dialog; handle the observed ref before checking its result'
        const context = {
            ref: this.dialog?.ref,
            targetId: this.identity.targetId,
            actionExecuted,
            actionStatus: actionExecuted === false ? 'not_started' : 'unknown',
            retryable: false,
        }
        return Object.assign(new Error(message), {
            code: 'DIALOG_OPEN',
            context,
            toJSON: () => ({ error: { code: 'DIALOG_OPEN', message, context } }),
        })
    }

    private status(): Record<string, unknown> {
        return {
            targetId: this.identity.targetId,
            sessionGeneration: this.identity.generation,
            capture: [...this.capture],
            fetchEnabled: this.fetchEnabled,
            routes: this.routes.size,
            authConfigured: !!this.credentials,
            dialogWatching: this.dialogWatching,
            downloadWatching: this.downloading,
            limits: {
                entries: MAX_ENTRIES,
                pending: MAX_PENDING,
                metadataBytes: MAX_METADATA,
                bodyBytes: MAX_BODY,
                cachedBodyBytes: MAX_BYTES,
                messageBytes: MAX_MESSAGE,
                ttlMs: TTL,
                pauseTtlMs: PAUSE_TTL,
            },
            dropped: this.dropped,
            evicted: this.evicted,
            cleanupFailures: this.cleanupFailures.map((failure) => failure.error),
            cleanupFailureDetails: this.cleanupFailures.map((failure) => ({ ...failure })),
            downloadCaptureFailures: [...this.entries.values()]
                .filter((e) => e.kind === 'download-capture' && typeof e.error === 'string')
                .map((e) => ({
                    ref: e.ref,
                    state: e.state,
                    nativeState: 'not-observed',
                    error: e.error ?? e.reason,
                    cleanupError: e.cleanupError,
                })),
        }
    }

    private async configureFetch(): Promise<void> {
        this.fetchConfig = this.fetchConfig
            .catch(() => {})
            .then(async () => {
                // A body read owns its pause until getResponseBody completes, including stop/cleanup.
                await Promise.all([...this.pauses.values()].map((p) => p.bodyRead))
                if ([...this.pauses.values()].some((p) => p.state === 'unknown')) {
                    throw new Error(
                        'Fetch cleanup outcome is unknown; configuration and debugger attachment are preserved'
                    )
                }
                const patterns = [...this.routes.values()].map((r) => ({
                    urlPattern: r.urlPattern,
                    requestStage: r.stage,
                }))
                if (this.downloading) {
                    patterns.push({ urlPattern: this.downloadPattern, requestStage: 'Response' })
                }
                if (this.credentials || (this.rawAuthentication && patterns.length === 0)) {
                    patterns.push({ urlPattern: '*', requestStage: 'Request' })
                }
                if (patterns.length || this.credentials || this.rawAuthentication) {
                    await this.send('Fetch.enable', {
                        patterns,
                        handleAuthRequests: !!this.credentials || this.rawAuthentication,
                    })
                    this.fetchEnabled = true
                } else if (this.fetchEnabled) {
                    if (this.pauses.size) {
                        throw new Error(
                            'Fetch cleanup is incomplete; pending requests and debugger attachment are preserved'
                        )
                    }
                    await this.send('Fetch.disable')
                    this.fetchEnabled = false
                }
            })
        await this.fetchConfig
    }

    private async onPaused(p: NativeEvent, sessionId?: string): Promise<void> {
        const stage = p.responseStatusCode !== undefined || p.responseErrorReason !== undefined ? 'Response' : 'Request'
        const rule = [...this.routes.entries()].find(
            ([, r]) => r.stage === stage && matches(p.request.url, r.urlPattern)
        )
        const native = { requestId: p.requestId }
        if (!rule && !(this.downloading && stage === 'Response' && matches(p.request.url, this.downloadPattern))) {
            await this.send(
                stage === 'Response' ? 'Fetch.continueResponse' : 'Fetch.continueRequest',
                native,
                sessionId
            )
            return
        }
        if (this.pauses.size >= MAX_PENDING) {
            this.dropped++
            await this.send('Fetch.failRequest', { ...native, errorReason: 'Aborted' }, sessionId)
            return
        }
        const headers = p.responseHeaders as Array<{ name: string; value: string }> | undefined
        const attachment = headers?.some(
            (h) => h.name.toLowerCase() === 'content-disposition' && /^attachment(?:;|$)/i.test(h.value)
        )
        if (!rule && !attachment) {
            await this.send('Fetch.continueResponse', native, sessionId)
            return
        }
        const entry = this.make(rule ? 'paused' : 'download-capture', {
            ...p,
            sessionId,
            state: 'pending',
            stage,
            ruleRef: rule?.[0],
            networkRef: this.latest(p.networkId, sessionId)?.ref,
        }) as Pause
        this.pauses.set(entry.ref, entry)
        entry.timer = setTimeout(() => {
            void this.abortOne(entry, 'pause timeout')
        }, PAUSE_TTL)
        if (!rule) {
            entry.bodyRead = (async () => {
                try {
                    const contentLength = Number(
                        headers?.find((h) => h.name.toLowerCase() === 'content-length')?.value ?? 0
                    )
                    if (contentLength >= MAX_BODY) {
                        // 配额拒绝与原生读取失败共用下方中止路径
                        // noinspection ExceptionCaughtLocallyJS
                        throw new Error('Download exceeds the original body budget')
                    }
                    const body = (await this.send('Fetch.getResponseBody', native, sessionId)) as {
                        body: string
                        base64Encoded: boolean
                    }
                    this.saveBody(entry.ref, { encoding: body.base64Encoded ? 'base64' : 'utf8', data: body.body })
                    if (p.frameId) {
                        const candidates = this.downloadBodies.get(p.frameId) ?? []
                        candidates.push({ ref: entry.ref, frameId: p.frameId, url: p.request.url })
                        this.downloadBodies.set(p.frameId, candidates.slice(-MAX_ENTRIES))
                    }
                    if (entry.abortReason) {
                        await this.send('Fetch.failRequest', { ...native, errorReason: 'Aborted' }, sessionId)
                        entry.state = 'aborted'
                        entry.reason = entry.abortReason
                    } else {
                        await this.send('Fetch.continueResponse', native, sessionId)
                        entry.state = 'resolved'
                    }
                } catch (e) {
                    this.nativeFailure(entry, e)
                    if (entry.state === 'expired') {
                        return
                    }
                    await this.send('Fetch.failRequest', { ...native, errorReason: 'Aborted' }, sessionId).then(
                        () => {
                            entry.state = 'aborted'
                        },
                        (cleanup) => {
                            this.nativeFailure(entry, cleanup)
                            entry.error = this.failure(e)
                            entry.cleanupError = this.failure(cleanup)
                            if (entry.state !== 'expired') {
                                this.recordCleanupFailure(
                                    cleanup,
                                    'downloadCapture:abort',
                                    entry.requestId,
                                    entry.sessionId,
                                    entry.ref
                                )
                            }
                        }
                    )
                } finally {
                    if (entry.state !== 'pending') {
                        clearTimeout(entry.timer)
                    }
                    if (['resolved', 'aborted', 'expired'].includes(entry.state)) {
                        this.pauses.delete(entry.ref)
                    }
                }
            })()
            await entry.bodyRead
        }
    }

    private async onAuth(p: NativeEvent, sessionId?: string): Promise<void> {
        const challenge = p.authChallenge as { source: string; origin: string; realm: string }
        if (this.pauses.size >= MAX_PENDING) {
            this.dropped++
            await this.send(
                'Fetch.continueWithAuth',
                { requestId: p.requestId, authChallengeResponse: { response: 'CancelAuth' } },
                sessionId
            )
            return
        }
        const key = `${this.key(p.requestId, sessionId)}\0${challenge.source}\0${challenge.origin}\0${challenge.realm}`
        const c = this.credentials
        if (this.rawAuthentication && !c) {
            const entry = this.make('auth', {
                requestId: p.requestId,
                challenge,
                sessionId,
                state: 'pending',
                response: 'awaiting-explicit-native-control',
                url: p.request?.url,
            }) as Pause
            this.pauses.set(entry.ref, entry)
            entry.timer = setTimeout(() => {
                void this.abortOne(entry, 'authentication timeout')
            }, PAUSE_TTL)
            return
        }
        const permitted =
            c &&
            c.source === challenge.source &&
            c.origin === challenge.origin &&
            (c.realm === undefined || c.realm === challenge.realm) &&
            !this.challenged.has(key)
        this.challenged.add(key)
        if (this.challenged.size > MAX_ENTRIES) {
            this.challenged.delete(this.challenged.values().next().value!)
        }
        const entry = this.make('auth', {
            requestId: p.requestId,
            challenge,
            sessionId,
            state: 'resolving',
            response: permitted ? 'ProvideCredentials' : 'CancelAuth',
            url: p.request?.url,
        }) as Pause
        this.pauses.set(entry.ref, entry)
        try {
            await this.send(
                'Fetch.continueWithAuth',
                {
                    requestId: p.requestId,
                    authChallengeResponse: permitted
                        ? { response: 'ProvideCredentials', username: c.username, password: c.password }
                        : { response: 'CancelAuth' },
                },
                sessionId
            )
            entry.state = 'resolved'
        } catch (e) {
            this.nativeFailure(entry, e)
        } finally {
            if (entry.state === 'resolved') {
                this.pauses.delete(entry.ref)
            }
        }
    }

    private async resolvePause(command: EventCommand): Promise<Record<string, unknown>> {
        const entry = this.require(command.ref, 'paused') as Pause
        if (entry.state !== 'pending') {
            return { ...this.status(), paused: redact(entry), alreadyProcessed: true }
        }
        let method = 'Fetch.continueRequest'
        const params: Record<string, unknown> = { requestId: entry.requestId }
        if (command.op === 'fail') {
            method = 'Fetch.failRequest'
            params.errorReason = command.errorReason ?? 'Aborted'
        } else if (command.op === 'fulfill') {
            method = 'Fetch.fulfillRequest'
            const response = command.response as {
                status: number
                statusText?: string
                headers?: Array<{ name: string; value: string }>
                body?: BytePayload
            }
            Object.assign(params, {
                responseCode: response.status,
                responsePhrase: response.statusText,
                responseHeaders: response.headers,
                body: response.body ? base64(response.body) : '',
            })
        } else {
            const request = command.request as
                | {
                      url?: string
                      method?: string
                      headers?: Array<{ name: string; value: string }>
                      body?: BytePayload
                  }
                | undefined
            if (entry.stage === 'Response') {
                if (request) {
                    throw new Error('Response-stage continue does not accept request overrides')
                }
                method = 'Fetch.continueResponse'
            } else if (request) {
                Object.assign(params, {
                    url: request.url,
                    method: request.method,
                    headers: request.headers,
                    postData: request.body ? base64(request.body) : undefined,
                })
            }
        }
        entry.state = 'resolving'
        clearTimeout(entry.timer)
        try {
            await this.send(method, params, entry.sessionId)
            entry.state = 'resolved'
        } catch (e) {
            this.nativeFailure(entry, e)
            throw e
        } finally {
            if (entry.state === 'resolved') {
                this.pauses.delete(entry.ref)
            }
        }
        return { ...this.status(), paused: redact(entry) }
    }

    private async abortOne(entry: Pause, reason: string): Promise<void> {
        entry.abortReason = reason
        await entry.bodyRead
        if (entry.state !== 'pending') {
            return
        }
        clearTimeout(entry.timer)
        entry.state = 'resolving'
        try {
            await this.send(
                entry.kind === 'auth' ? 'Fetch.continueWithAuth' : 'Fetch.failRequest',
                {
                    requestId: entry.requestId,
                    ...(entry.kind === 'auth'
                        ? { authChallengeResponse: { response: 'CancelAuth' } }
                        : { errorReason: 'Aborted' }),
                },
                entry.sessionId
            )
            entry.state = 'aborted'
            entry.reason = reason
        } catch (e) {
            this.nativeFailure(entry, e)
            if (entry.state !== 'expired') {
                entry.cleanupError = this.failure(e)
                this.recordCleanupFailure(e, `abortPending:${reason}`, entry.requestId, entry.sessionId, entry.ref)
            }
        } finally {
            if (entry.state === 'aborted') {
                this.pauses.delete(entry.ref)
            }
        }
    }

    private async readBody(request: Request, view: 'requestBody' | 'responseBody'): Promise<BytePayload> {
        const bodyKey = view === 'requestBody' ? `${request.ref}/request` : request.ref
        const cached = this.bodies.get(bodyKey)
        if (cached) {
            return cached
        }
        if (this.latest(request.requestId, request.sessionId) !== request) {
            throw new Error('Redirect-hop body is unavailable from the native protocol')
        }
        if (view === 'responseBody' && request.state !== 'finished') {
            throw new Error(`Original response body unavailable while request is ${request.state}`)
        }
        const result = (await this.send(
            view === 'requestBody' ? 'Network.getRequestPostData' : 'Network.getResponseBody',
            { requestId: request.requestId },
            request.sessionId
        )) as { body?: string; base64Encoded?: boolean; postData?: string }
        const data = view === 'requestBody' ? result.postData : result.body
        if (typeof data !== 'string') {
            throw new Error('Native protocol did not provide the original body (multipart file parts are not provided)')
        }
        const payload: BytePayload = { encoding: result.base64Encoded ? 'base64' : 'utf8', data }
        this.saveBody(bodyKey, payload)
        return payload
    }

    private async read(options: BrowserEventRead): Promise<Record<string, unknown>> {
        this.sweep()
        const view = options.view ?? 'summary'
        const selected = options.ref ? this.require(options.ref) : undefined
        if (view === 'requestBody' || view === 'responseBody') {
            const entry = this.require(options.ref, 'request') as Request
            const payload = await this.readBody(entry, view)
            if (options.clear) {
                this.remove(entry.ref)
            }
            return {
                ...this.status(),
                ref: entry.ref,
                payload,
                bytes: bytes(payload),
                bodySource: 'native-protocol-entity',
                limitations: view === 'requestBody' ? ['Multipart file parts are omitted by the native protocol'] : [],
            }
        }
        const kind =
            options.type === 'network'
                ? view === 'stream'
                    ? 'stream'
                    : view === 'paused'
                      ? 'paused'
                      : view === 'auth'
                        ? 'auth'
                        : 'request'
                : options.type
        if (selected && selected.kind !== kind) {
            throw new Error('Browser event ref kind does not match the requested view')
        }
        const entries = [...this.entries.values()].filter(
            (e) =>
                e.kind === kind &&
                (!selected || e.ref === selected.ref) &&
                (!options.urlPattern ||
                    matches(
                        String(e.url ?? (e.request as NativeEvent['request'] | undefined)?.url ?? ''),
                        options.urlPattern
                    ))
        )
        const logs = entries.slice(-(options.limit ?? 100)).map((e) => {
            if (kind === 'request' && view === 'summary') {
                return redact({
                    ref: e.ref,
                    requestId: e.requestId,
                    hop: e.hop,
                    url: e.url,
                    method: (e.request as Record<string, unknown>).method,
                    status: (e.response as Record<string, unknown> | undefined)?.status,
                    type: e.type,
                    state: e.state,
                    timestamp: e.timestamp,
                })
            }
            return redact({
                ...e,
                ...(kind === 'request'
                    ? {
                          headersSource: {
                              base: 'requestWillBeSent/responseReceived',
                              actual: 'ExtraInfo',
                              complete: e.extraExpected === false || (!!e.responseExtraInfo && !!e.requestExtraInfo),
                          },
                      }
                    : {}),
                ...(kind === 'download'
                    ? {
                          artifact:
                              typeof e.bodyRef === 'string' && this.bodies.has(e.bodyRef) ? 'available' : 'unavailable',
                      }
                    : {}),
            })
        })
        if (options.clear) {
            for (const e of entries) {
                if (!this.pauses.has(e.ref) && e !== this.dialog) {
                    this.remove(e.ref)
                }
            }
        }
        return { ...this.status(), logs, count: logs.length, totalBuffered: entries.length, view }
    }

    private notifyDownloads(): void {
        for (const notify of this.downloadWaiters) {
            notify()
        }
    }

    private async waitDownload(entry: Entry, timeout: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
        await new Promise<void>((resolve, reject) => {
            const check = () => {
                if (!this.active) {
                    cleanup()
                    reject(new Error('Download session closed'))
                    return
                }
                if (entry.state !== 'inProgress') {
                    cleanup()
                    resolve()
                }
            }
            const abort = () => {
                cleanup()
                reject(signal?.reason ?? new Error('Download wait cancelled'))
            }
            const timer = setTimeout(() => {
                cleanup()
                reject(new Error('Download is still in progress at timeout'))
            }, timeout)
            const cleanup = () => {
                clearTimeout(timer)
                this.downloadWaiters.delete(check)
                signal?.removeEventListener('abort', abort)
            }
            this.downloadWaiters.add(check)
            signal?.addEventListener('abort', abort, { once: true })
            check()
            if (signal?.aborted) {
                abort()
            }
        })
        return { ...this.status(), download: redact(entry) }
    }
}

export const BROWSER_EVENT_METHODS = [
    'Page.javascriptDialogOpening',
    'Page.javascriptDialogClosed',
    'Page.frameNavigated',
    'Page.downloadWillBegin',
    'Page.downloadProgress',
    'Network.requestWillBeSent',
    'Network.requestWillBeSentExtraInfo',
    'Network.responseReceived',
    'Network.responseReceivedExtraInfo',
    'Network.loadingFinished',
    'Network.loadingFailed',
    'Network.webSocketCreated',
    'Network.webSocketWillSendHandshakeRequest',
    'Network.webSocketHandshakeResponseReceived',
    'Network.webSocketFrameSent',
    'Network.webSocketFrameReceived',
    'Network.webSocketFrameError',
    'Network.webSocketClosed',
    'Network.eventSourceMessageReceived',
    'Fetch.requestPaused',
    'Fetch.authRequired',
] as const
