import { z } from 'zod'

const ref = z.string().min(1)
const payload = z.object({ encoding: z.enum(['utf8', 'base64']), data: z.string().max(24 * 1024 * 1024) }).strict()
const headers = z.array(z.object({ name: z.string().min(1), value: z.string() }).strict()).max(1000)
const request = z
    .object({
        url: z.url().optional(),
        method: z.string().min(1).optional(),
        headers: headers.optional(),
        body: payload.optional(),
    })
    .strict()
const response = z
    .object({
        status: z.number().int().min(100).max(599),
        statusText: z.string().optional(),
        headers: headers.optional(),
        body: payload.optional(),
    })
    .strict()
export const dialogCommandSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('watch') }).strict(),
    z.object({ op: z.literal('stop') }).strict(),
    z.object({ op: z.literal('accept'), ref, text: z.string().optional() }).strict(),
    z.object({ op: z.literal('dismiss'), ref }).strict(),
])
export const captureCommandSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('start'), include: z.array(z.enum(['body', 'stream'])).optional() }).strict(),
    z.object({ op: z.literal('stop') }).strict(),
])
export const routeCommandSchema = z.discriminatedUnion('op', [
    z
        .object({
            op: z.literal('add'),
            urlPattern: z.string().min(1).max(4096),
            stage: z.enum(['Request', 'Response']).optional(),
        })
        .strict(),
    z.object({ op: z.literal('remove'), ref }).strict(),
    z.object({ op: z.literal('continue'), ref, request: request.optional() }).strict(),
    z.object({ op: z.literal('fulfill'), ref, response }).strict(),
    z
        .object({
            op: z.literal('fail'),
            ref,
            errorReason: z
                .enum([
                    'Failed',
                    'Aborted',
                    'TimedOut',
                    'AccessDenied',
                    'ConnectionClosed',
                    'ConnectionReset',
                    'ConnectionRefused',
                    'ConnectionAborted',
                    'ConnectionFailed',
                    'NameNotResolved',
                    'InternetDisconnected',
                    'AddressUnreachable',
                    'BlockedByClient',
                    'BlockedByResponse',
                ])
                .optional(),
        })
        .strict(),
])
export const authCommandSchema = z.discriminatedUnion('op', [
    z
        .object({
            op: z.literal('set'),
            scope: z
                .object({ source: z.enum(['Server', 'Proxy']), origin: z.url(), realm: z.string().optional() })
                .strict(),
            username: z.string(),
            password: z.string(),
        })
        .strict(),
    z.object({ op: z.literal('clear') }).strict(),
])
export const downloadCommandSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('watch'), urlPattern: z.string().min(1).max(4096).optional() }).strict(),
    z.object({ op: z.literal('stop') }).strict(),
    z.object({ op: z.literal('wait'), ref, timeout: z.number().positive().max(120_000).optional() }).strict(),
    z.object({ op: z.literal('save'), ref, output: z.string().min(1) }).strict(),
])
export const eventReadSchema = z
    .object({
        type: z.enum(['dialog', 'download', 'network']),
        view: z.enum(['summary', 'details', 'requestBody', 'responseBody', 'stream', 'paused', 'auth']).optional(),
        ref: ref.optional(),
        limit: z.number().int().positive().max(1000).optional(),
        clear: z.boolean().optional(),
        urlPattern: z.string().optional(),
    })
    .strict()
export const browserEventCommandSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('dialog'), command: dialogCommandSchema }).strict(),
    z.object({ action: z.literal('networkCapture'), command: captureCommandSchema }).strict(),
    z.object({ action: z.literal('route'), command: routeCommandSchema }).strict(),
    z.object({ action: z.literal('httpAuth'), command: authCommandSchema }).strict(),
    z.object({ action: z.literal('download'), command: downloadCommandSchema }).strict(),
    z.object({ action: z.literal('read'), command: eventReadSchema }).strict(),
])
