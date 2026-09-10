import { z } from 'zod'

export const sshPortSchema = z.number().int().min(1).max(65535)

export const dynamicSshPortSchema = z.number().int().min(0).max(65535)

export const operationTimeoutSchema = z
    .number()
    .int()
    .positive()
    .max(3_600_000)
    .describe('操作超时（毫秒），默认 600000，超时后远端状态可能未知')
