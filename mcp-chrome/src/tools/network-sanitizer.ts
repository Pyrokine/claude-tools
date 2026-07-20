const REDACTED_VALUE = '[REDACTED]'

const SENSITIVE_QUERY_PARAMETER =
    /^(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|code|credential|id[_-]?token|key|password|passwd|proxy[_-]?authorization|refresh[_-]?token|secret|sig|signature|token|x-amz-credential|x-amz-security-token|x-amz-signature|x-goog-credential|x-goog-signature)$/i

export interface SanitizedUrl {
    url: string
    urlRedacted?: true
    urlOriginalLength?: number
    redactedQueryParameters?: string[]
}

function decodeQueryParameterName(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '))
    } catch {
        return value
    }
}

export function sanitizeUrl(rawUrl: string): SanitizedUrl {
    const queryIndex = rawUrl.indexOf('?')
    if (queryIndex < 0) {
        return { url: rawUrl }
    }

    const fragmentIndex = rawUrl.indexOf('#', queryIndex)
    const queryEnd = fragmentIndex >= 0 ? fragmentIndex : rawUrl.length
    const query = rawUrl.slice(queryIndex + 1, queryEnd)
    const redactedNames: string[] = []
    const sanitizedQuery = query
        .split('&')
        .map((part) => {
            const separatorIndex = part.indexOf('=')
            const encodedName = separatorIndex >= 0 ? part.slice(0, separatorIndex) : part
            const name = decodeQueryParameterName(encodedName)
            if (!SENSITIVE_QUERY_PARAMETER.test(name)) {
                return part
            }
            if (!redactedNames.includes(name)) {
                redactedNames.push(name)
            }
            return `${encodedName}=${REDACTED_VALUE}`
        })
        .join('&')

    if (redactedNames.length === 0) {
        return { url: rawUrl }
    }

    return {
        url: `${rawUrl.slice(0, queryIndex + 1)}${sanitizedQuery}${rawUrl.slice(queryEnd)}`,
        urlRedacted: true,
        urlOriginalLength: rawUrl.length,
        redactedQueryParameters: redactedNames,
    }
}

export function sanitizeUrlRecord<T extends { url?: string; urlRedacted?: true }>(
    record: T
): T & Omit<SanitizedUrl, 'url'> {
    if (typeof record.url !== 'string' || record.urlRedacted) {
        return record
    }
    const sanitized = sanitizeUrl(record.url)
    if (!sanitized.urlRedacted) {
        return record
    }
    return {
        ...record,
        ...sanitized,
    }
}

export function sanitizeUrlRecords<T extends { url?: string }>(records: T[]): Array<T & Omit<SanitizedUrl, 'url'>> {
    return records.map(sanitizeUrlRecord)
}
