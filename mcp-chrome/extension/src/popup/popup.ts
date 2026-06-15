/**
 * MCP Chrome Extension - Popup UI
 */

const statusIndicator = document.getElementById('statusIndicator')!
const statusText = document.getElementById('statusText')!
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement
const disconnectBtn = document.getElementById('disconnectBtn') as HTMLButtonElement
const pairingTokenInput = document.getElementById('pairingTokenInput') as HTMLInputElement
const saveTokenBtn = document.getElementById('saveTokenBtn') as HTMLButtonElement
const authHelp = document.getElementById('authHelp')!

// 获取状态
async function updateStatus() {
    try {
        const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' })

        if (response.connected) {
            const ports: number[] = response.ports ?? []
            statusIndicator.className = 'status-indicator connected'

            if (ports.length > 1) {
                statusText.textContent = `已连接 ${ports.length} 个服务器 (${ports.join(', ')})`
            } else if (ports.length === 1) {
                statusText.textContent = `已连接 (端口 ${ports[0]})`
            } else {
                statusText.textContent = '已连接'
            }

            connectBtn.disabled = true
            disconnectBtn.disabled = false
        } else {
            statusIndicator.className = 'status-indicator disconnected'
            statusText.textContent = '未连接'
            connectBtn.disabled = false
            disconnectBtn.disabled = true
        }

        authHelp.textContent = response.pairingTokenConfigured
            ? '已配置 token，只连接同 token 的 MCP Server'
            : '未配置 token，使用本地信任模式'
    } catch (error) {
        console.error('Failed to get status:', error)
        statusIndicator.className = 'status-indicator disconnected'
        statusText.textContent = '未连接'
    }
}

// 连接
connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true
    statusText.textContent = '连接中...'

    try {
        const response = await chrome.runtime.sendMessage({ type: 'CONNECT' })

        if (response.connected > 0) {
            await updateStatus()
        } else {
            statusText.textContent = '未找到 MCP Server'
            connectBtn.disabled = false
        }
    } catch (error) {
        console.error('Connect failed:', error)
        statusText.textContent = '连接失败'
        connectBtn.disabled = false
    }
})

saveTokenBtn.addEventListener('click', async () => {
    saveTokenBtn.disabled = true
    try {
        await chrome.runtime.sendMessage({ type: 'SET_PAIRING_TOKEN', token: pairingTokenInput.value })
        pairingTokenInput.value = ''
        await updateStatus()
    } catch (error) {
        console.error('Save token failed:', error)
        authHelp.textContent = '保存 token 失败'
    } finally {
        saveTokenBtn.disabled = false
    }
})

// 断开
disconnectBtn.addEventListener('click', async () => {
    try {
        await chrome.runtime.sendMessage({ type: 'DISCONNECT' })
        await updateStatus()
    } catch (error) {
        console.error('Disconnect failed:', error)
    }
})

// 监听状态更新
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATUS_UPDATE') {
        void updateStatus()
    }
})

// 初始化
void updateStatus()
