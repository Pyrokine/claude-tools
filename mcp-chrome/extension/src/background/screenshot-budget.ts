const MAX_DIMENSION = 16384
const MAX_PIXELS = 12_000_000
const MAX_ESTIMATED_BYTES = 48 * 1024 * 1024
const MAX_ENCODED_BYTES = 25 * 1024 * 1024

export function assertScreenshotBudget(width: number, height: number, scale = 1): void {
    const w = Math.ceil(width * scale)
    const h = Math.ceil(height * scale)
    if (
        !Number.isFinite(w) ||
        !Number.isFinite(h) ||
        w <= 0 ||
        h <= 0 ||
        w > MAX_DIMENSION ||
        h > MAX_DIMENSION ||
        w * h > MAX_PIXELS ||
        w * h * 4 > MAX_ESTIMATED_BYTES
    ) {
        throw new Error(`screenshot 尺寸 ${w}x${h} 超出预算，请用 clip 或 scale 缩小截图`)
    }
}

export function assertScreenshotBase64Budget(data: string): void {
    if (Math.floor((data.length * 3) / 4) > MAX_ENCODED_BYTES) {
        throw new Error(`screenshot 数据超过 ${MAX_ENCODED_BYTES} 字节，请用 clip 或 scale 缩小截图`)
    }
}
