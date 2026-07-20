/**
 * Action 处理器共享工具函数
 *
 * 纯工具函数，不依赖任何实例状态，可被多个 handler 模块直接 import 使用
 */

import type { FrameProbeMessage } from '../types'
import { ExpectedOperationError } from '../types/expected-errors'
import { isManagedTab } from './tab-state'

export interface ActionContext {
    mcpTabGroupId: number | null
    mcpWindowId: number | null
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
    const tab = await chrome.tabs.get(tabId)
    if (isRestrictedUrl(tab.url)) {
        throw new ExpectedOperationError(
            `Cannot execute on restricted URL "${tab.url}". Navigate to an http/https page first.`
        )
    }
}

export async function getTargetTabId(tabId?: number): Promise<number> {
    if (tabId !== undefined && tabId !== null) {
        try {
            await chrome.tabs.get(tabId)
        } catch {
            throw new ExpectedOperationError(`Tab ${tabId} 不存在（可能已被关闭）`)
        }
        return tabId
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!activeTab?.id) {
        throw new ExpectedOperationError('No active tab found')
    }
    return activeTab.id
}

export function tabToInfo(tab: chrome.tabs.Tab, context: ActionContext) {
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
        managed: isManagedTab(tab, context),
        status: tab.status || 'unknown',
    }
}

export async function assertManagedTab(
    tabId: number,
    context: ActionContext,
    operation: string
): Promise<chrome.tabs.Tab> {
    let tab: chrome.tabs.Tab
    try {
        tab = await chrome.tabs.get(tabId)
    } catch {
        throw new ExpectedOperationError(`Tab ${tabId} 不存在（可能已被关闭）`)
    }
    if (!isManagedTab(tab, context)) {
        const detail = JSON.stringify({
            tabId,
            managed: false,
            groupId: tab.groupId,
            mcpTabGroupId: context.mcpTabGroupId,
            windowId: tab.windowId,
            mcpWindowId: context.mcpWindowId,
        })
        throw new ExpectedOperationError(
            `${operation} 拒绝操作非托管 tab, ${detail}, 请使用 browse(action="list") 选择 managed=true 的受控 tab, 或用 manage(action="newPage") 创建受控页面`
        )
    }
    return tab
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
}

export interface DomFrameSnapshot {
    parent: {
        title: string | null
        rect: { x: number; y: number; width: number; height: number }
    }
    frames: DomFrameSnapshotFrame[]
    selectedIndex: number | null
    selectionStatus: DomFrameSelectionStatus
    selectionError?: string
}

const FRAME_PROBE_TIMEOUT_MS = 500

interface PendingDomFrameProbe {
    tabId: number
    frameIdsByIndex: Map<number, number[]>
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

/**
 * 将父文档里的 DOM iframe 与 Chrome frameId 建立可验证映射
 *
 * webNavigation 可能包含页面 DOM 不可见的其他 Extension frame，因此不能按两个列表的顺序配对
 * 这里向每个 DOM iframe 的 contentWindow 发送一次随机 probe，再从对应 content script 的 sender 读取实际 frameId
 */
export async function getDomFrameSnapshot(
    tabId: number,
    parentFrameId: number,
    selection?: string | number
): Promise<DomFrameSnapshot> {
    const token = crypto.randomUUID()
    const pendingProbe: PendingDomFrameProbe = { tabId, frameIdsByIndex: new Map() }
    pendingDomFrameProbes.set(token, pendingProbe)

    try {
        const parentResults = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [parentFrameId] },
            func: async (probeToken: string, requestedSelection: string | number | null, timeoutMs: number) => {
                const iframes = Array.from(document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[]
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
                        const selected = document.querySelector(requestedSelection)
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
                                    if (settled) return
                                    settled = true
                                    window.clearTimeout(timer)
                                    window.removeEventListener('message', onMessage)
                                    resolve(value)
                                }
                                const onMessage = (event: MessageEvent) => {
                                    const data = event.data as { type?: string; token?: string; index?: number } | null
                                    if (
                                        event.source === child &&
                                        data?.type === 'mcp-frame-probe-ack' &&
                                        data.token === probeToken &&
                                        data.index === index
                                    ) {
                                        finish(true)
                                    }
                                }
                                const timer = window.setTimeout(() => finish(false), timeoutMs)
                                window.addEventListener('message', onMessage)
                                child.postMessage({ type: 'mcp-frame-probe', token: probeToken, index }, '*')
                            })
                    )
                )

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
            },
            args: [token, selection ?? null, FRAME_PROBE_TIMEOUT_MS],
        })

        const parentResult = parentResults[0]?.result as
            | {
                  parent: DomFrameSnapshot['parent']
                  frames: Array<
                      Omit<DomFrameSnapshotFrame, 'frameId' | 'candidateFrameIds'> & { acknowledged: boolean }
                  >
                  selectedIndex: number | null
                  selectionStatus: DomFrameSelectionStatus
                  selectionError?: string
              }
            | undefined
        if (!parentResult) {
            throw new ExpectedOperationError(`无法读取 parent frame ${parentFrameId} 的 iframe DOM`)
        }

        return {
            parent: parentResult.parent,
            frames: parentResult.frames.map(({ acknowledged, ...frame }) => {
                const candidateFrameIds = acknowledged ? (pendingProbe.frameIdsByIndex.get(frame.index) ?? []) : []
                return {
                    ...frame,
                    frameId: candidateFrameIds.length === 1 ? candidateFrameIds[0] : null,
                    candidateFrameIds: candidateFrameIds.slice(0, 10),
                }
            }),
            selectedIndex: parentResult.selectedIndex,
            selectionStatus: parentResult.selectionStatus,
            ...(parentResult.selectionError ? { selectionError: parentResult.selectionError } : {}),
        }
    } finally {
        pendingDomFrameProbes.delete(token)
    }
}

/**
 * 递归计算 iframe 在页面坐标系中的偏移量
 *
 * 对于嵌套 iframe，递归累加各层偏移，clientLeft/clientTop 补偿 iframe border
 */
export async function getFrameOffset(tabId: number, frameId: number): Promise<{ x: number; y: number } | null> {
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId })
    const targetFrame = allFrames?.find((frame) => frame.frameId === frameId)
    if (!targetFrame || targetFrame.parentFrameId === -1) {
        return null
    }

    const tab = await chrome.tabs.get(tabId)
    if (isRestrictedUrl(tab.url)) {
        return null
    }

    let parentOffset = { x: 0, y: 0 }
    if (targetFrame.parentFrameId !== 0) {
        const resolvedParentOffset = await getFrameOffset(tabId, targetFrame.parentFrameId)
        if (!resolvedParentOffset) {
            return null
        }
        parentOffset = resolvedParentOffset
    }

    const snapshot = await getDomFrameSnapshot(tabId, targetFrame.parentFrameId)
    const mappedFrame = snapshot.frames.find((frame) => frame.frameId === frameId)
    if (!mappedFrame) {
        return null
    }

    return {
        x: parentOffset.x + mappedFrame.contentOffset.x,
        y: parentOffset.y + mappedFrame.contentOffset.y,
    }
}
