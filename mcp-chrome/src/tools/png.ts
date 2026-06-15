import { deflateSync, inflateSync } from 'zlib'

export const MAX_COMPARE_PNG_BYTES = 25 * 1024 * 1024
export const MAX_COMPARE_PIXELS = 12_000_000

interface DecodedPng {
    width: number
    height: number
    rgba: Buffer
}

export interface PngComparison {
    pixelDiffRatio: number
    differentPixels: number
    totalPixels: number
    width: number
    height: number
    diffPng: Buffer
}

export function comparePngImages(before: Buffer, after: Buffer): PngComparison {
    assertPngCompareWithinLimits(before, 'baseline')
    assertPngCompareWithinLimits(after, 'screenshot')
    const a = decodePng(before)
    const b = decodePng(after)
    const width = Math.max(a.width, b.width)
    const height = Math.max(a.height, b.height)
    const totalPixels = width * height
    if (totalPixels > MAX_COMPARE_PIXELS) {
        throw new Error(`对比结果像素数 ${totalPixels} 超过 ${MAX_COMPARE_PIXELS}，请使用 clip 或 scale 缩小截图`)
    }
    const diff = Buffer.alloc(width * height * 4)
    let differentPixels = 0

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const out = (y * width + x) * 4
            const ai = x < a.width && y < a.height ? (y * a.width + x) * 4 : -1
            const bi = x < b.width && y < b.height ? (y * b.width + x) * 4 : -1
            const same =
                ai >= 0 &&
                bi >= 0 &&
                a.rgba[ai] === b.rgba[bi] &&
                a.rgba[ai + 1] === b.rgba[bi + 1] &&
                a.rgba[ai + 2] === b.rgba[bi + 2] &&
                a.rgba[ai + 3] === b.rgba[bi + 3]
            if (same) {
                diff[out] = bi >= 0 ? b.rgba[bi] : 255
                diff[out + 1] = bi >= 0 ? b.rgba[bi + 1] : 255
                diff[out + 2] = bi >= 0 ? b.rgba[bi + 2] : 255
                diff[out + 3] = 80
            } else {
                differentPixels++
                diff[out] = 255
                diff[out + 1] = 0
                diff[out + 2] = 0
                diff[out + 3] = 255
            }
        }
    }

    return {
        pixelDiffRatio: totalPixels === 0 ? 0 : differentPixels / totalPixels,
        differentPixels,
        totalPixels,
        width,
        height,
        diffPng: encodePng(width, height, diff),
    }
}

export function readPngHeader(buffer: Buffer): { width: number; height: number } {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (!buffer.subarray(0, 8).equals(signature)) {
        throw new Error('screenshot compare 需要 PNG 文件')
    }
    if (buffer.length < 33 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error('screenshot compare 需要有效 PNG IHDR')
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function assertPngCompareWithinLimits(buffer: Buffer, label: string): void {
    if (buffer.length > MAX_COMPARE_PNG_BYTES) {
        throw new Error(`${label} PNG 超过 ${MAX_COMPARE_PNG_BYTES} 字节，请使用 clip 或 scale 缩小截图`)
    }
    const header = readPngHeader(buffer)
    const pixels = header.width * header.height
    if (pixels > MAX_COMPARE_PIXELS) {
        throw new Error(`${label} PNG 像素数 ${pixels} 超过 ${MAX_COMPARE_PIXELS}，请使用 clip 或 scale 缩小截图`)
    }
}

function decodePng(buffer: Buffer): DecodedPng {
    readPngHeader(buffer)

    let offset = 8
    let width = 0
    let height = 0
    let colorType = 0
    const idat: Buffer[] = []
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset)
        const type = buffer.toString('ascii', offset + 4, offset + 8)
        const data = buffer.subarray(offset + 8, offset + 8 + length)
        offset += 12 + length
        if (type === 'IHDR') {
            width = data.readUInt32BE(0)
            height = data.readUInt32BE(4)
            const bitDepth = data[8]
            colorType = data[9]
            const interlace = data[12]
            if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
                throw new Error('screenshot compare 仅支持 8-bit non-interlaced RGB/RGBA PNG')
            }
        } else if (type === 'IDAT') {
            idat.push(data)
        } else if (type === 'IEND') {
            break
        }
    }

    const bytesPerPixel = colorType === 6 ? 4 : 3
    const stride = width * bytesPerPixel
    const raw = inflateSync(Buffer.concat(idat))
    const rgba = Buffer.alloc(width * height * 4)
    let input = 0
    let prev = Buffer.alloc(stride)
    for (let y = 0; y < height; y++) {
        const filter = raw[input++]
        const row = Buffer.from(raw.subarray(input, input + stride))
        input += stride
        unfilterRow(row, prev, bytesPerPixel, filter)
        for (let x = 0; x < width; x++) {
            const src = x * bytesPerPixel
            const dst = (y * width + x) * 4
            rgba[dst] = row[src]
            rgba[dst + 1] = row[src + 1]
            rgba[dst + 2] = row[src + 2]
            rgba[dst + 3] = bytesPerPixel === 4 ? row[src + 3] : 255
        }
        prev = row
    }
    return { width, height, rgba }
}

function unfilterRow(row: Buffer, prev: Buffer, bpp: number, filter: number): void {
    for (let i = 0; i < row.length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0
        const up = prev[i] ?? 0
        const upLeft = i >= bpp ? prev[i - bpp] : 0
        if (filter === 1) {
            row[i] = (row[i] + left) & 0xff
        } else if (filter === 2) {
            row[i] = (row[i] + up) & 0xff
        } else if (filter === 3) {
            row[i] = (row[i] + Math.floor((left + up) / 2)) & 0xff
        } else if (filter === 4) {
            row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff
        } else if (filter !== 0) {
            throw new Error(`Unsupported PNG filter: ${filter}`)
        }
    }
}

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    if (pa <= pb && pa <= pc) {
        return a
    }
    return pb <= pc ? b : c
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
    const stride = width * 4
    const raw = Buffer.alloc((stride + 1) * height)
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ])
}

function pngChunk(type: string, data: Buffer): Buffer {
    const name = Buffer.from(type, 'ascii')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
    return Buffer.concat([length, name, data, crc])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    return c >>> 0
})

function crc32(buffer: Buffer): number {
    let c = 0xffffffff
    for (const byte of buffer) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}
