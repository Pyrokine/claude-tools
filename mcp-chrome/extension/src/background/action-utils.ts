/**
 * Action 处理器共享工具函数
 *
 * 纯工具函数，不依赖任何实例状态，可被多个 handler 模块直接 import 使用
 */

import { installDomHelpers } from '../../../src/core/dom-helpers.js'
import type { FrameProbeMessage } from '../types'
import { ExpectedOperationError } from '../types/expected-errors'
import { getExistingTab, pageRevision } from './page-revision'
import { installFrameProbeListener } from './page-scripts'
import { readGrantDocumentId } from './read-grants'
import { getManagedTabMetadata, isManagedTab } from './tab-state'

export interface ActionContext {
    mcpTabGroupId: number | null
    mcpWindowId: number | null
    serverInstanceId?: string | null
    signal?: AbortSignal
    deadline?: number
}

export function assertActionActive(
    context: ActionContext | undefined,
    progress?: { action: string; targetId?: string; windowId?: number; groupId?: number }
): void {
    if (context && (context.signal?.aborted || (context.deadline !== undefined && Date.now() >= context.deadline))) {
        throw new ExpectedOperationError(
            JSON.stringify({
                error: {
                    code: context.signal?.aborted ? 'REQUEST_CANCELLED' : 'TIMEOUT',
                    message: context.signal?.aborted
                        ? progress
                            ? 'Request cancelled; remaining changes stopped'
                            : 'Request cancelled before dispatch'
                        : progress
                          ? 'Request timeout; remaining changes stopped'
                          : 'Request timeout before dispatch',
                    context: {
                        ...progress,
                        actionExecuted: progress ? true : false,
                        actionStatus: progress ? 'partial' : 'not_started',
                        retryable: false,
                    },
                },
            }),
            progress ? undefined : false
        )
    }
}

export function isRestrictedUrl(url: string | undefined): boolean {
    if (!url) {
        return true
    }
    return (
        url === 'about:blank' ||
        url.startsWith('about:') ||
        url.startsWith('chrome://') ||
        url.startsWith('chrome-extension://')
    )
}

export async function assertScriptable(tabId: number): Promise<void> {
    const tab = await getExistingTab(tabId)
    if (isRestrictedUrl(tab.url)) {
        throw new ExpectedOperationError(
            `Cannot execute on restricted URL "${tab.url}". Navigate to an http/https page first.`
        )
    }
}

export async function getTargetTabId(tabId?: number): Promise<number> {
    if (tabId !== undefined && tabId !== null) {
        await getExistingTab(tabId)
        return tabId
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!activeTab?.id) {
        throw new ExpectedOperationError('No active tab found')
    }
    return activeTab.id
}

export function tabToInfo(tab: chrome.tabs.Tab) {
    return {
        id: tab.id!,
        url: tab.url || '',
        title: tab.title || '',
        active: tab.active,
        windowId: tab.windowId,
        index: tab.index,
        groupId: tab.groupId,
        pinned: tab.pinned,
        incognito: tab.incognito,
        highlighted: tab.highlighted,
        autoDiscardable: tab.autoDiscardable,
        muted: tab.mutedInfo?.muted,
        mutedInfo: tab.mutedInfo,
        audible: tab.audible,
        discarded: tab.discarded,
        frozen: tab.frozen,
        openerTabId: tab.openerTabId,
        pendingUrl: tab.pendingUrl,
        favIconUrl: tab.favIconUrl,
        lastAccessed: tab.lastAccessed,
        width: tab.width,
        height: tab.height,
        splitViewId: tab.splitViewId,
        managed: isManagedTab(tab),
        metadata: getManagedTabMetadata(tab.id!),
        status: tab.status || 'unknown',
        revision: pageRevision(tab.id!),
    }
}

export async function assertManagedTab(
    tabId: number,
    context: ActionContext,
    operation: string
): Promise<chrome.tabs.Tab> {
    const tab = await getExistingTab(tabId)
    if (!isManagedTab(tab)) {
        const detail = JSON.stringify({
            tabId,
            managed: false,
            groupId: tab.groupId,
            mcpTabGroupId: context.mcpTabGroupId,
            windowId: tab.windowId,
            mcpWindowId: context.mcpWindowId,
        })
        throw new ExpectedOperationError(
            `${operation} 拒绝操作非托管 tab, ${detail}, ` +
                '请用 manage(action="adoptPage", targetId="' +
                tabId +
                '") 将目标页面设为受控，或创建新页面'
        )
    }
    return tab
}

export async function assertReadableTab(
    tabId: number,
    context: ActionContext,
    operation: string
): Promise<{ tab: chrome.tabs.Tab; documentId?: string }> {
    const tab = await getExistingTab(tabId)
    if (isManagedTab(tab)) {
        return { tab }
    }
    const documentId = await readGrantDocumentId(context.serverInstanceId, tabId, () => assertActionActive(context))
    if (documentId) {
        return { tab, documentId }
    }
    throw new ExpectedOperationError(
        `${operation} 拒绝读取非托管 tab ${tabId}，请显式 adoptPage，` +
            `或用 manage(action="grantReadAccess", targetId="${tabId}") 授予普通只读权限`
    )
}

export type DomFrameSelectionStatus =
    'not-requested' | 'found' | 'not-found' | 'not-frame' | 'out-of-range' | 'invalid-selector'

export interface DomFrameSnapshotFrame {
    index: number
    frameId: number | null
    candidateFrameIds: number[]
    url: string
    title: string | null
    name: string | null
    selector: string | null
    rect: { x: number; y: number; width: number; height: number }
    contentOffset: { x: number; y: number }
    zoom: number
}

export interface DomFrameSnapshot {
    parent: {
        title: string | null
        rect: { x: number; y: number; width: number; height: number }
    }
    frames: DomFrameSnapshotFrame[]
    unavailableFrames?: Array<{ frameId: number; documentId?: string; url: string; error: string }>
    selectedIndex: number | null
    selectionStatus: DomFrameSelectionStatus
    selectionError?: string
}

interface DomFrameProbeResult {
    parent: DomFrameSnapshot['parent']
    frames: Array<Omit<DomFrameSnapshotFrame, 'frameId' | 'candidateFrameIds'> & { acknowledged: boolean }>
    selectedIndex: number | null
    selectionStatus: DomFrameSelectionStatus
    selectionError?: string
}

declare global {
    var __mcpDomFrameProbes: Map<string, { result: Promise<DomFrameProbeResult>; cancel: () => void }> | undefined
}

const FRAME_PROBE_TIMEOUT_MS = 500

async function waitForFrameProbe<T>(
    operation: Promise<T>,
    cancel: () => Promise<unknown>,
    context?: ActionContext
): Promise<T> {
    let rejectCancellation: (error: unknown) => void
    const cancellationFailure = new Promise<never>((_, reject) => {
        rejectCancellation = reject
    })
    let stopped = false
    const stop = () => {
        if (!stopped) {
            stopped = true
            void cancel().catch((error: unknown) => rejectCancellation(error))
        }
    }
    const expiresAt = Math.min(Date.now() + FRAME_PROBE_TIMEOUT_MS, context?.deadline ?? Infinity)
    let timer: ReturnType<typeof setTimeout>
    const onTimeout = () => {
        if (stopped) {
            return
        }
        const remaining = expiresAt - Date.now()
        if (remaining > 0) {
            timer = setTimeout(onTimeout, remaining)
        } else {
            stop()
        }
    }
    timer = setTimeout(onTimeout, Math.max(0, expiresAt - Date.now()))
    context?.signal?.addEventListener('abort', stop, { once: true })
    if (context?.signal?.aborted) {
        stop()
    }
    try {
        const result = await Promise.race([operation, cancellationFailure])
        assertActionActive(context)
        return result
    } catch (error) {
        assertActionActive(context)
        throw error
    } finally {
        clearTimeout(timer)
        context?.signal?.removeEventListener('abort', stop)
    }
}

interface PendingDomFrameProbe {
    tabId: number
    frameIdsByIndex: Map<number, number[]>
    documentId?: string
}

const pendingDomFrameProbes = new Map<string, PendingDomFrameProbe>()

export function recordDomFrameProbe(
    message: FrameProbeMessage,
    sender: chrome.runtime.MessageSender
): { accepted: boolean } {
    const pending = pendingDomFrameProbes.get(message.token)
    if (
        !pending ||
        sender.tab?.id !== pending.tabId ||
        sender.frameId === undefined ||
        sender.frameId === 0 ||
        (pending.documentId !== undefined && sender.documentId !== pending.documentId) ||
        !Number.isInteger(message.index) ||
        message.index < 0
    ) {
        return { accepted: false }
    }

    const frameIds = pending.frameIdsByIndex.get(message.index) ?? []
    if (!frameIds.includes(sender.frameId)) {
        frameIds.push(sender.frameId)
        pending.frameIdsByIndex.set(message.index, frameIds)
    }
    return { accepted: true }
}

/** 向 CDP 返回的实际 owner 节点探测，避免异步等待后按旧 DOM index 选择其他 iframe */
export async function probeCdpFrameOwner(
    tabId: number,
    documentId: string,
    cdpFrameId: string,
    sessionId?: string,
    context?: ActionContext
): Promise<number | null> {
    assertActionActive(context)
    const debuggee = { tabId, ...(sessionId ? { sessionId } : {}) }
    await waitForFrameProbe(
        chrome.scripting.executeScript({
            target: { tabId, documentIds: [documentId] },
            injectImmediately: true,
            func: installFrameProbeListener,
        }),
        () => Promise.reject(new ExpectedOperationError('Frame probe listener installation timed out', false)),
        context
    )
    assertActionActive(context)
    const owner = (await chrome.debugger.sendCommand(debuggee, 'DOM.getFrameOwner', { frameId: cdpFrameId })) as {
        backendNodeId: number
    }
    const resolved = (await chrome.debugger.sendCommand(debuggee, 'DOM.resolveNode', {
        backendNodeId: owner.backendNodeId,
    })) as { object: { objectId?: string } }
    const objectId = resolved.object.objectId
    if (!objectId) {
        return null
    }
    const token = crypto.randomUUID()
    const pending: PendingDomFrameProbe = { tabId, documentId, frameIdsByIndex: new Map() }
    pendingDomFrameProbes.set(token, pending)
    let promiseObjectId: string | undefined
    try {
        assertActionActive(context)
        const probe = (await chrome.debugger.sendCommand(debuggee, 'Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function(token) {
                const child = this.contentWindow;
                if (!this.isConnected || !child) return false;
                let cancel;
                const promise = new Promise((resolve, reject) => {
                    const finish = value => {
                        window.removeEventListener('message', onMessage);
                        resolve(value);
                    };
                    cancel = () => finish(false);
                    const onMessage = event => {
                        if (event.source === child && event.data?.type === 'mcp-frame-probe-ack-v2' &&
                            event.data.token === token && event.data.index === 0) finish(true);
                    };
                    window.addEventListener('message', onMessage);
                    try {
                        child.postMessage({type:'mcp-frame-probe-v2', token, index:0}, '*');
                    } catch (error) {
                        window.removeEventListener('message', onMessage);
                        reject(error);
                    }
                });
                promise.cancel = cancel;
                return promise;
            }`,
            arguments: [{ value: token }],
            awaitPromise: false,
            returnByValue: false,
        })) as { result?: { objectId?: string }; exceptionDetails?: unknown }
        promiseObjectId = probe.result?.objectId
        if (probe.exceptionDetails || !promiseObjectId) {
            return null
        }
        const result = (await waitForFrameProbe(
            chrome.debugger.sendCommand(debuggee, 'Runtime.awaitPromise', {
                promiseObjectId,
                returnByValue: true,
            }),
            () =>
                chrome.debugger.sendCommand(debuggee, 'Runtime.callFunctionOn', {
                    objectId: promiseObjectId,
                    functionDeclaration: 'function() { this.cancel(); }',
                    returnByValue: true,
                }),
            context
        )) as { result?: { value?: boolean }; exceptionDetails?: unknown }
        const ids = pending.frameIdsByIndex.get(0) ?? []
        return !result.exceptionDetails && result.result?.value === true && ids.length === 1 ? ids[0] : null
    } finally {
        pendingDomFrameProbes.delete(token)
        if (promiseObjectId) {
            await chrome.debugger
                .sendCommand(debuggee, 'Runtime.callFunctionOn', {
                    objectId: promiseObjectId,
                    functionDeclaration: 'function() { this.cancel(); }',
                    returnByValue: true,
                })
                .catch((error) => {
                    console.debug('[MCP] Frame owner probe cancellation failed', error)
                })
        }
        for (const id of [promiseObjectId, objectId]) {
            if (id) {
                await chrome.debugger
                    .sendCommand(debuggee, 'Runtime.releaseObject', { objectId: id })
                    .catch((error) => {
                        console.debug('[MCP] Frame owner probe cleanup failed', error)
                    })
            }
        }
    }
}

/**
 * 将父文档里的 DOM iframe 与 Chrome frameId 建立可验证映射
 *
 * webNavigation 可能包含页面 DOM 不可见的其他 Extension frame，因此不能按两个列表的顺序配对
 * 这里向每个 DOM iframe 的 contentWindow 发送一次随机 probe，再从对应 content script 的 sender 读取实际 frameId
 */
export async function getDomFrameSnapshot(
    tabId: number,
    parentFrameId: number,
    selection?: string | number,
    documentId?: string,
    expectedUrl?: string,
    context?: ActionContext
): Promise<DomFrameSnapshot> {
    assertActionActive(context)
    const chromeFrames = await chrome.webNavigation.getAllFrames({ tabId })
    const parentFrame = chromeFrames?.find((frame) => frame.frameId === parentFrameId)
    if (
        documentId &&
        (parentFrame?.documentId !== documentId || (expectedUrl !== undefined && parentFrame.url !== expectedUrl))
    ) {
        throw new ExpectedOperationError(`parent frame ${parentFrameId} 页面已变化，未读取`)
    }
    if (!chromeFrames || !parentFrame?.documentId) {
        throw new ExpectedOperationError(`无法读取 parent frame ${parentFrameId} 的 documentId`)
    }
    const unavailableFrames: NonNullable<DomFrameSnapshot['unavailableFrames']> = []
    const verifiedFrameIds = new Set<number>()
    const childFrames = chromeFrames.filter(
        (frame) =>
            frame.parentFrameId === parentFrameId &&
            frame.parentDocumentId === parentFrame.documentId &&
            !frame.errorOccurred &&
            (!isRestrictedUrl(frame.url) || /^about:(?:blank|srcdoc)(?:[?#]|$)/.test(frame.url))
    )
    await Promise.all(
        childFrames.map(async (frame) => {
            try {
                if (!frame.documentId) {
                    // noinspection ExceptionCaughtLocallyJS -- Report failure
                    throw new ExpectedOperationError(`无法读取 iframe ${frame.frameId} 的 documentId`)
                }
                await waitForFrameProbe(
                    chrome.scripting.executeScript({
                        target: { tabId, documentIds: [frame.documentId] },
                        injectImmediately: true,
                        func: installFrameProbeListener,
                    }),
                    () =>
                        Promise.reject(
                            new ExpectedOperationError('Frame probe listener installation timed out', false)
                        ),
                    context
                )
                verifiedFrameIds.add(frame.frameId)
            } catch (error) {
                unavailableFrames.push({
                    frameId: frame.frameId,
                    documentId: frame.documentId,
                    url: frame.url,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        })
    )
    assertActionActive(context)
    const token = crypto.randomUUID()
    const pendingProbe: PendingDomFrameProbe = { tabId, frameIdsByIndex: new Map() }
    pendingDomFrameProbes.set(token, pendingProbe)

    const target = { tabId, documentIds: [parentFrame.documentId] }
    const stopProbe = (remove: boolean) =>
        chrome.scripting.executeScript({
            target,
            injectImmediately: true,
            func: function stopDomFrameProbe(probeToken: string, remove: boolean) {
                const probes = globalThis.__mcpDomFrameProbes
                probes?.get(probeToken)?.cancel()
                if (remove) {
                    probes?.delete(probeToken)
                    if (probes?.size === 0) {
                        delete globalThis.__mcpDomFrameProbes
                    }
                }
            },
            args: [token, remove],
        })
    let probeStarted = false
    try {
        const setup = await chrome.scripting.executeScript({ target, injectImmediately: true, func: installDomHelpers })
        if (!setup[0] || (setup[0] as { error?: unknown }).error) {
            throw new ExpectedOperationError('无法准备 frame DOM 查询，未读取子页面')
        }
        assertActionActive(context)
        const started = await chrome.scripting.executeScript({
            target,
            injectImmediately: true,
            func: function startDomFrameProbe(
                probeToken: string,
                requestedSelection: string | number | null,
                url?: string
            ) {
                const cancellations: Array<() => void> = []
                const result = (async (): Promise<DomFrameProbeResult> => {
                    if (url !== undefined && location.href !== url) {
                        throw new Error('页面 URL 已变化，未读取')
                    }
                    const iframes = globalThis.__mcpDomHelpers!.query({
                        selector: 'iframe, frame',
                    }) as HTMLIFrameElement[]
                    let selectedIndex: number | null = null
                    let selectionStatus: DomFrameSelectionStatus = 'not-requested'
                    let selectionError: string | undefined

                    if (typeof requestedSelection === 'number') {
                        if (requestedSelection < 0 || requestedSelection >= iframes.length) {
                            selectionStatus = 'out-of-range'
                        } else {
                            selectedIndex = requestedSelection
                            selectionStatus = 'found'
                        }
                    } else if (typeof requestedSelection === 'string') {
                        try {
                            const selected = globalThis.__mcpDomHelpers!.query({ selector: requestedSelection })[0]
                            if (!selected) {
                                selectionStatus = 'not-found'
                            } else if (!selected.matches('iframe, frame')) {
                                selectionStatus = 'not-frame'
                            } else {
                                selectedIndex = iframes.indexOf(selected as HTMLIFrameElement)
                                selectionStatus = selectedIndex >= 0 ? 'found' : 'not-found'
                            }
                        } catch (error) {
                            selectionStatus = 'invalid-selector'
                            selectionError = (error instanceof Error ? error.message : String(error)).slice(0, 300)
                        }
                    }

                    const acknowledged = await Promise.all(
                        iframes.map(
                            (frame, index) =>
                                new Promise<boolean>((resolve) => {
                                    const child = frame.contentWindow
                                    if (!child) {
                                        resolve(false)
                                        return
                                    }

                                    let settled = false
                                    const finish = (value: boolean) => {
                                        if (settled) {
                                            return
                                        }
                                        settled = true
                                        window.removeEventListener('message', onMessage)
                                        resolve(value)
                                    }
                                    const onMessage = (event: MessageEvent) => {
                                        const data = event.data as {
                                            type?: string
                                            token?: string
                                            index?: number
                                        } | null
                                        if (
                                            event.source === child &&
                                            data?.type === 'mcp-frame-probe-ack-v2' &&
                                            data.token === probeToken &&
                                            data.index === index
                                        ) {
                                            finish(true)
                                        }
                                    }
                                    cancellations.push(() => finish(false))
                                    window.addEventListener('message', onMessage)
                                    child.postMessage({ type: 'mcp-frame-probe-v2', token: probeToken, index }, '*')
                                })
                        )
                    )

                    if (url !== undefined && location.href !== url) {
                        throw new Error('页面 URL 已变化，未读取')
                    }
                    return {
                        parent: {
                            title: document.title || null,
                            rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
                        },
                        frames: iframes.map((frame, index) => {
                            const rect = frame.getBoundingClientRect()
                            return {
                                index,
                                acknowledged: acknowledged[index],
                                url: frame.src || '',
                                title: frame.title || null,
                                name: frame.name || null,
                                selector: frame.id
                                    ? `#${CSS.escape(frame.id)}`
                                    : `${frame.tagName.toLowerCase()}:nth-of-type(${index + 1})`,
                                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                                zoom: (() => {
                                    const current = (frame as Element & { currentCSSZoom?: number }).currentCSSZoom
                                    if (current !== undefined) {
                                        return current
                                    }
                                    let zoom = 1
                                    for (
                                        let node: Element | null = frame;
                                        node;
                                        node =
                                            node.assignedSlot ??
                                            node.parentElement ??
                                            (node.getRootNode() as ShadowRoot).host ??
                                            null
                                    ) {
                                        zoom *= Number.parseFloat(window.getComputedStyle(node).zoom) || 1
                                    }
                                    return zoom
                                })(),
                                contentOffset: {
                                    x: rect.x + frame.clientLeft,
                                    y: rect.y + frame.clientTop,
                                },
                            }
                        }),
                        selectedIndex,
                        selectionStatus,
                        selectionError,
                    }
                })()
                void result.catch((error) => console.debug('[MCP] Frame DOM probe failed', error))
                const probes = (globalThis.__mcpDomFrameProbes ??= new Map())
                probes.set(probeToken, { result, cancel: () => cancellations.forEach((cancel) => cancel()) })
                return true
            },
            args:
                documentId && expectedUrl !== undefined
                    ? [token, selection ?? null, expectedUrl]
                    : [token, selection ?? null],
        })
        if (started[0]?.result !== true) {
            throw new ExpectedOperationError(`无法启动 parent frame ${parentFrameId} 的 iframe 探测`)
        }
        probeStarted = true
        assertActionActive(context)
        const parentResults = await waitForFrameProbe(
            chrome.scripting.executeScript({
                target,
                injectImmediately: true,
                func: async function awaitDomFrameProbe(probeToken: string) {
                    const probe = globalThis.__mcpDomFrameProbes?.get(probeToken)
                    if (!probe) {
                        throw new Error('Frame probe is unavailable')
                    }
                    return await probe.result
                },
                args: [token],
            }),
            () => stopProbe(false),
            context
        )

        const parentResult = parentResults[0]?.result as DomFrameProbeResult | undefined
        if (!parentResult) {
            throw new ExpectedOperationError(`无法读取 parent frame ${parentFrameId} 的 iframe DOM`)
        }

        return {
            parent: parentResult.parent,
            frames: parentResult.frames.map(({ acknowledged, ...frame }) => {
                const candidateFrameIds = acknowledged ? (pendingProbe.frameIdsByIndex.get(frame.index) ?? []) : []
                return {
                    ...frame,
                    frameId:
                        candidateFrameIds.length === 1 && verifiedFrameIds.has(candidateFrameIds[0]!)
                            ? candidateFrameIds[0]
                            : null,
                    candidateFrameIds: candidateFrameIds.slice(0, 10),
                }
            }),
            ...(unavailableFrames.length
                ? { unavailableFrames: unavailableFrames.sort((a, b) => a.frameId - b.frameId) }
                : {}),
            selectedIndex: parentResult.selectedIndex,
            selectionStatus: parentResult.selectionStatus,
            ...(parentResult.selectionError ? { selectionError: parentResult.selectionError } : {}),
        }
    } finally {
        pendingDomFrameProbes.delete(token)
        if (probeStarted) {
            await stopProbe(true).catch((error) => {
                console.debug('[MCP] Frame DOM probe cleanup failed', error)
            })
        }
    }
}

interface CdpFrameIdentity {
    frame: chrome.webNavigation.GetAllFrameResultDetails
    cdpFrameId: string
    ownerTarget: chrome.debugger.DebuggerSession
    queryTarget: chrome.debugger.DebuggerSession
}

export async function resolveCdpFramePath(
    tabId: number,
    selected: chrome.webNavigation.GetAllFrameResultDetails,
    targets: chrome.debugger.DebuggerSession[],
    context: ActionContext
): Promise<CdpFrameIdentity[]> {
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    const path = [selected]
    while (path[0]!.frameId !== 0) {
        const parent = frames?.find((frame) => frame.frameId === path[0]!.parentFrameId)
        if (!parent?.documentId || path.some((frame) => frame.frameId === parent.frameId)) {
            throw new ExpectedOperationError('FRAME_IDENTITY_CHANGED: frame parent document is unavailable', false)
        }
        path.unshift(parent)
    }
    type FrameTree = { frame: { id: string; parentId?: string }; childFrames?: FrameTree[] }
    const trees: Array<{ target: chrome.debugger.DebuggerSession; tree: FrameTree }> = []
    const parents = new Map<string, string>()
    const collect = (tree: FrameTree, parent?: string) => {
        const parentId = tree.frame.parentId ?? parent
        if (parentId) {
            parents.set(tree.frame.id, parentId)
        }
        for (const child of tree.childFrames ?? []) {
            collect(child, tree.frame.id)
        }
    }
    for (const target of targets) {
        assertActionActive(context)
        const result = (await chrome.debugger.sendCommand(target, 'Page.getFrameTree')) as { frameTree: FrameTree }
        trees.push({ target, tree: result.frameTree })
        collect(result.frameTree)
    }
    let target = targets[0]!
    let parentId = trees[0]!.tree.frame.id
    const result: CdpFrameIdentity[] = [
        { frame: path[0]!, cdpFrameId: parentId, ownerTarget: target, queryTarget: target },
    ]
    for (const frame of path.slice(1)) {
        assertActionActive(context)
        const candidates = [...parents].filter(([, parent]) => parent === parentId).map(([id]) => id)
        const matches: string[] = []
        for (const candidate of candidates) {
            if (
                (await probeCdpFrameOwner(tabId, frame.documentId!, candidate, target.sessionId, context)) ===
                frame.frameId
            ) {
                matches.push(candidate)
            }
        }
        if (matches.length !== 1) {
            throw new ExpectedOperationError(
                JSON.stringify({
                    error: {
                        code: candidates.length > 1 ? 'FRAME_AMBIGUOUS' : 'FRAME_IDENTITY_CHANGED',
                        message: 'Cannot verify one native frame owner',
                        context: {
                            tabId,
                            extensionFrameId: frame.frameId,
                            actionExecuted: false,
                            candidateCount: candidates.length,
                        },
                    },
                }),
                false
            )
        }
        const cdpFrameId = matches[0]!
        const queryTarget = trees.find((tree) => tree.tree.frame.id === cdpFrameId)?.target ?? target
        result.push({ frame, cdpFrameId, ownerTarget: target, queryTarget })
        target = queryTarget
        parentId = cdpFrameId
    }
    return result
}

export async function getFrameWheelZoom(
    tabId: number,
    frameId: number,
    documentId: string | undefined,
    context: ActionContext
): Promise<number> {
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    const path: chrome.webNavigation.GetAllFrameResultDetails[] = []
    let current = frames?.find((frame) => frame.frameId === frameId)
    if (!current?.documentId || (documentId && current.documentId !== documentId)) {
        throw new Error('Wheel frame identity changed before zoom lookup')
    }
    let zoom = 1
    while (current.parentFrameId >= 0) {
        assertActionActive(context)
        if (path.some((frame) => frame.frameId === current!.frameId)) {
            throw new Error('Wheel frame parent identity is cyclic')
        }
        path.push(current)
        const parent = frames?.find((frame) => frame.frameId === current!.parentFrameId)
        if (!parent?.documentId) {
            throw new Error('Wheel parent document is unavailable')
        }
        const snapshot = await getDomFrameSnapshot(
            tabId,
            parent.frameId,
            undefined,
            parent.documentId,
            parent.url,
            context
        )
        const owners = snapshot.frames.filter((owner) => owner.frameId === current!.frameId)
        if (owners.length !== 1 || !Number.isFinite(owners[0]!.zoom) || owners[0]!.zoom <= 0) {
            throw new Error('Wheel frame zoom owner is unavailable')
        }
        zoom *= owners[0]!.zoom
        current = parent
    }
    path.push(current)
    for (const expected of path) {
        const actual = await chrome.webNavigation.getFrame({ tabId, frameId: expected.frameId })
        if (!actual || actual.documentId !== expected.documentId || actual.parentFrameId !== expected.parentFrameId) {
            throw new Error('Wheel frame identity changed during zoom lookup')
        }
    }
    return zoom
}

/**
 * 递归计算 iframe 在页面坐标系中的偏移量
 *
 * 对于嵌套 iframe，递归累加各层偏移，clientLeft/clientTop 补偿 iframe border
 */
export async function getFrameOffset(
    tabId: number,
    frameId: number,
    context?: ActionContext
): Promise<{ x: number; y: number } | null> {
    assertActionActive(context)
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId })
    const targetFrame = allFrames?.find((frame) => frame.frameId === frameId)
    if (!targetFrame || targetFrame.parentFrameId === -1) {
        return null
    }

    const tab = await getExistingTab(tabId)
    if (isRestrictedUrl(tab.url)) {
        return null
    }

    let parentOffset = { x: 0, y: 0 }
    if (targetFrame.parentFrameId !== 0) {
        const resolvedParentOffset = await getFrameOffset(tabId, targetFrame.parentFrameId, context)
        if (!resolvedParentOffset) {
            return null
        }
        parentOffset = resolvedParentOffset
    }

    const snapshot = await getDomFrameSnapshot(
        tabId,
        targetFrame.parentFrameId,
        undefined,
        undefined,
        undefined,
        context
    )
    const mappedFrame = snapshot.frames.find((frame) => frame.frameId === frameId)
    if (!mappedFrame) {
        return null
    }

    return {
        x: parentOffset.x + mappedFrame.contentOffset.x,
        y: parentOffset.y + mappedFrame.contentOffset.y,
    }
}
