export function isUtf8ContinuationByte(value: number): boolean {
    return (value & 0xc0) === 0x80
}

function utf8SequenceLength(value: number): number {
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

export function ensureUtf8Boundary(buffer: Buffer, offset: number, field: string): void {
    if (offset < buffer.length && isUtf8ContinuationByte(buffer[offset])) {
        throw new Error(`${field} must point to a UTF-8 character boundary`)
    }
}

export function utf8SafeEnd(
    buffer: Buffer,
    start: number,
    requestedEnd: number,
    stream: string,
    limitedByMaxBytes: boolean = requestedEnd < buffer.length
): number {
    let end = requestedEnd
    if (limitedByMaxBytes) {
        while (end > start && isUtf8ContinuationByte(buffer[end])) {
            --end
        }
    }

    if (end > start) {
        let sequenceStart = end - 1
        while (sequenceStart > start && isUtf8ContinuationByte(buffer[sequenceStart])) {
            --sequenceStart
        }
        if (sequenceStart + utf8SequenceLength(buffer[sequenceStart]) > end) {
            end = sequenceStart
        }
    }

    if (end === start && requestedEnd > start && limitedByMaxBytes) {
        throw new Error(`maxBytes is too small to read the next UTF-8 character from ${stream}`)
    }
    return end
}
