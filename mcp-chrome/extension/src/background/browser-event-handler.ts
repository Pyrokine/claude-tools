import {
    BrowserEventController,
    type BrowserEventAction,
    type EventCommand,
    eventRefTarget,
} from '../../../src/core/browser-events'
import { browserEventCommandSchema } from '../../../src/core/browser-event-schema'
import { assertActionActive, assertManagedTab, assertReadableTab, type ActionContext } from './action-utils'
import { ExpectedOperationError } from '../types/expected-errors'
import type { DebuggerManager } from './debugger-manager'

export class BrowserEventHandler {
    private controllers = new Map<string, BrowserEventController>()
    private fetchOwners = new Map<number, string>()
    constructor(private debuggerManager: DebuggerManager) {
        debuggerManager.addEventConsumer((tabId, method, params, sessionId) => {
            for (const controller of this.controllers.values()) {
                if (controller.identity.targetId !== String(tabId)) {
                    continue
                }
                if (method.startsWith('Fetch.') && this.fetchOwners.get(tabId) !== controller.identity.owner) {
                    continue
                }
                controller.handle(method, params, sessionId)
            }
        })
        debuggerManager.beforeDetach = (tabId, reason, owner) => this.suspendTab(tabId, reason, owner)
        debuggerManager.onCleanup = (tabId) => {
            void this.cleanupTab(tabId)
        }
    }

    controller(tabId: number, context: ActionContext): BrowserEventController {
        const owner = context.serverInstanceId
        if (!owner) {
            throw new ExpectedOperationError('Browser events require a server instance identity', false)
        }
        const key = this.key(tabId, owner)
        let controller = this.controllers.get(key)
        if (!controller) {
            if (this.controllers.size >= 128) {
                throw new ExpectedOperationError(
                    'Browser event observation capacity reached; stop unused observations',
                    false
                )
            }
            controller = new BrowserEventController(
                { backend: 'extension', targetId: String(tabId), owner, generation: crypto.randomUUID() },
                (method, params, sessionId) =>
                    chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params)
            )
            this.controllers.set(key, controller)
        }
        return controller
    }

    async execute(raw: unknown, context: ActionContext): Promise<unknown> {
        const p = raw as { tabId?: number; action?: BrowserEventAction; command?: EventCommand; deadline?: number }
        const parsed = browserEventCommandSchema.parse({ action: p.action, command: p.command })
        let tabId = p.tabId
        const ref = 'ref' in parsed.command ? parsed.command.ref : undefined
        if (typeof ref === 'string') {
            const identity = eventRefTarget(ref)
            if (identity.backend !== 'extension' || (tabId !== undefined && String(tabId) !== identity.targetId)) {
                throw new ExpectedOperationError('Browser event ref target mismatch', false)
            }
            tabId = Number(identity.targetId)
        }
        if (!Number.isSafeInteger(tabId) || tabId! < 0) {
            throw new ExpectedOperationError('Browser events require an explicit tabId or ref', false)
        }
        assertActionActive(context)
        if (parsed.action === 'read') {
            await assertReadableTab(tabId!, context, 'browser_events')
        } else {
            await assertManagedTab(tabId!, context, 'browser_events')
        }
        const controller = this.controller(tabId!, context)
        if (parsed.action !== 'read') {
            this.claimFetch(tabId!, context, parsed.action)
            await this.debuggerManager.ensureAttached(tabId!)
        }
        assertActionActive(context)
        const abort = () => {
            void controller.abortPending('request cancelled')
        }
        context.signal?.addEventListener('abort', abort, { once: true })
        try {
            const result = await controller.command(parsed.action, parsed.command as EventCommand, context.signal)
            if (!result.fetchEnabled && this.fetchOwners.get(tabId!) === context.serverInstanceId) {
                this.fetchOwners.delete(tabId!)
            }
            return result
        } catch (error) {
            if (context.signal?.aborted) {
                await controller.abortPending('request cancelled')
            }
            throw error
        } finally {
            context.signal?.removeEventListener('abort', abort)
        }
    }

    async rawFetch(
        tabId: number,
        method: string,
        params: Record<string, unknown> | undefined,
        context: ActionContext
    ): Promise<unknown> {
        this.claimFetch(tabId, context, 'raw')
        const result = await this.controller(tabId, context).rawFetch(method, params)
        if (method === 'Fetch.disable') {
            this.fetchOwners.delete(tabId)
        }
        return result
    }

    async suspendTab(tabId: number, reason: string, owner?: string | null): Promise<Record<string, unknown>> {
        const fetchOwner = this.fetchOwners.get(tabId)
        if (owner && fetchOwner && fetchOwner !== owner) {
            return {
                targetId: String(tabId),
                suspended: false,
                reason: 'Fetch is controlled by another server instance',
                cleanupFailures: [],
                cleanupFailureDetails: [],
            }
        }
        const states = []
        for (const controller of this.controllers.values()) {
            if (controller.identity.targetId === String(tabId) && (!owner || controller.identity.owner === owner)) {
                states.push(await controller.suspend(reason))
            }
        }
        const suspended = states.every((state) => state.suspended === true)
        if (suspended && (!owner || fetchOwner === owner)) {
            this.fetchOwners.delete(tabId)
        }
        return {
            targetId: String(tabId),
            suspended,
            observations: states,
            cleanupFailures: states.flatMap((state) => (state.cleanupFailures as string[]) ?? []),
            cleanupFailureDetails: states.flatMap(
                (state) => (state.cleanupFailureDetails as Array<Record<string, unknown>>) ?? []
            ),
        }
    }

    async cleanupTab(tabId: number): Promise<void> {
        for (const [key, controller] of this.controllers) {
            if (controller.identity.targetId === String(tabId)) {
                await controller
                    .dispose('debugger detached or page released')
                    .catch((error) =>
                        console.warn(
                            '[MCP] Browser event detach cleanup outcome unknown:',
                            controller.identity.targetId,
                            error
                        )
                    )
                this.controllers.delete(key)
            }
        }
        this.fetchOwners.delete(tabId)
    }

    async releaseOwner(owner: string): Promise<void> {
        for (const [key, controller] of this.controllers) {
            if (controller.identity.owner === owner) {
                await controller.dispose('server disconnected')
                this.controllers.delete(key)
                const tabId = Number(controller.identity.targetId)
                if (this.fetchOwners.get(tabId) === owner) {
                    this.fetchOwners.delete(tabId)
                }
            }
        }
    }

    private key(tabId: number, owner: string): string {
        return `${tabId}\0${owner}`
    }

    private claimFetch(tabId: number, context: ActionContext, action: string): void {
        if (!['route', 'httpAuth', 'download', 'raw'].includes(action)) {
            return
        }
        const owner = this.fetchOwners.get(tabId)
        if (owner && owner !== context.serverInstanceId) {
            throw new ExpectedOperationError('Fetch is controlled by another server instance on this page', false)
        }
        this.fetchOwners.set(tabId, context.serverInstanceId!)
    }
}
