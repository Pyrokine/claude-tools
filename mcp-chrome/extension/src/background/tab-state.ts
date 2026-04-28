/**
 * Tab 状态外提
 *
 * 把 mcpTabGroupId / mcpWindowId 从 index.ts 抽出，破除
 * tab-handler ↔ index ↔ actions 的循环依赖（tab-handler 通过 setter
 * 写入状态，actions/handlers 通过 context 读取）
 */

let mcpTabGroupId: number | null = null
let mcpWindowId: number | null = null

export function getMcpTabGroupId(): number | null {
    return mcpTabGroupId
}

export function getMcpWindowId(): number | null {
    return mcpWindowId
}

export function setMcpTabGroupId(groupId: number | null): void {
    mcpTabGroupId = groupId
}

export function setMcpWindowId(windowId: number | null): void {
    mcpWindowId = windowId
}
