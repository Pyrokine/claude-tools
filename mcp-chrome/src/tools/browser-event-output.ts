import { formatResponse, resolveScopedOutputPath, writePrivateFile } from '../core/index.js'
import type { BytePayload } from '../core/browser-events.js'

export async function browserEventResponse(
    result: Record<string, unknown>,
    output?: string,
    assertActive?: () => void
) {
    const { payload: rawPayload, ...metadata } = result
    const payload = rawPayload as BytePayload | undefined
    if (output) {
        assertActive?.()
        const path = (await resolveScopedOutputPath(output, 'mcp-chrome')).absolutePath
        const data = payload
            ? Buffer.from(payload.data, payload.encoding === 'base64' ? 'base64' : 'utf8')
            : Buffer.from(JSON.stringify(metadata, null, 2))
        await writePrivateFile(path, data, undefined, assertActive)
        return formatResponse({ success: true, ...metadata, output: path, bytes: data.length })
    }
    if (payload && Buffer.byteLength(payload.data) > 1024 * 1024) {
        throw new Error('Original body exceeds the inline budget; provide output to receive the complete bytes')
    }
    return formatResponse({ success: true, ...metadata, ...(payload ? { payload } : {}) })
}
