/**
 * 核心模块导出
 */

export * from './types.js'
export * from './errors.js'
export {
    CWD_PATH_PREFIX,
    TMP_PATH_PREFIX,
    ensureParentDir,
    escapeXPathString,
    getControlledTempRoot,
    resolveScopedInputPath,
    resolveScopedOutputPath,
    type ResolvedScopedPath,
    type ScopedPathScope,
} from './utils.js'
export { Locator, type LocatorOptions } from './locator.js'
export { getSession } from './session.js'
export { getUnifiedSession, type ConnectionMode } from './unified-session.js'
export { withRetry, type RetryOptions } from './retry.js'
export { AutoWait, type AutoWaitOptions } from './auto-wait.js'
