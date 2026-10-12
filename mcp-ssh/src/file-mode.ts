const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

export const FILE_CREATE_MODE_MASK = 0o777
export const FILE_MODE_MASK = 0o7777

export function extractFileMode(mode: number): number {
    return mode & FILE_MODE_MASK
}

export function formatFileMode(mode: number): string {
    return extractFileMode(mode).toString(8).padStart(4, '0')
}

function executeCharacter(mode: number, executeBit: number, specialBit: number, special: string): string {
    if (mode & specialBit) {
        return mode & executeBit ? special : special.toUpperCase()
    }
    return mode & executeBit ? 'x' : '-'
}

export function formatFilePermissions(mode: number): string {
    const fileType = mode & S_IFMT
    const type = fileType === S_IFDIR ? 'd' : fileType === S_IFLNK ? 'l' : fileType === S_IFREG ? '-' : '?'
    const permissions = [
        mode & 0o400 ? 'r' : '-',
        mode & 0o200 ? 'w' : '-',
        executeCharacter(mode, 0o100, 0o4000, 's'),
        mode & 0o040 ? 'r' : '-',
        mode & 0o020 ? 'w' : '-',
        executeCharacter(mode, 0o010, 0o2000, 's'),
        mode & 0o004 ? 'r' : '-',
        mode & 0o002 ? 'w' : '-',
        executeCharacter(mode, 0o001, 0o1000, 't'),
    ]
    return type + permissions.join('')
}

export function parseExpectedFileMode(value: string): number | undefined {
    const trimmed = value.trim()
    if (/^[0-7]{3,4}$/.test(trimmed)) {
        return Number.parseInt(trimmed, 8) & FILE_MODE_MASK
    }

    const match = /^(?:[-dl?])?([r-][w-][xSs-][r-][w-][xSs-][r-][w-][xTt-])$/.exec(trimmed)
    if (!match) {
        return undefined
    }

    const bits = match[1]
    let mode = 0
    if (bits[0] === 'r') mode |= 0o400
    if (bits[1] === 'w') mode |= 0o200
    if (bits[2] === 'x' || bits[2] === 's') mode |= 0o100
    if (bits[2] === 's' || bits[2] === 'S') mode |= 0o4000
    if (bits[3] === 'r') mode |= 0o040
    if (bits[4] === 'w') mode |= 0o020
    if (bits[5] === 'x' || bits[5] === 's') mode |= 0o010
    if (bits[5] === 's' || bits[5] === 'S') mode |= 0o2000
    if (bits[6] === 'r') mode |= 0o004
    if (bits[7] === 'w') mode |= 0o002
    if (bits[8] === 'x' || bits[8] === 't') mode |= 0o001
    if (bits[8] === 't' || bits[8] === 'T') mode |= 0o1000
    return mode
}
