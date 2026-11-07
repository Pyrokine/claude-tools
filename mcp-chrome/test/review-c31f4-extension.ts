export { ActionHandler } from '../extension/src/background/actions'
export { HttpClient } from '../extension/src/background/http-client'
export {
    getManagedTabRecord,
    isManagedTab,
    markManagedTab,
    restoreManagedTabs,
    unmarkManagedTab,
} from '../extension/src/background/tab-state'
export { hasReadGrant, setReadGrant, revokeReadGrants } from '../extension/src/background/read-grants'
