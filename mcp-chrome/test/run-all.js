#!/usr/bin/env node

/**
 * mcp-chrome 完整测试
 *
 * 前置条件：
 * 1. npm run build 编译通过
 * 2. Chrome Extension 已加载且已连接
 *
 * 测试站点：demoqa.com
 */

import {McpClient, parseToolResult, TestReporter} from './helpers.js';

const TEST_URL = 'https://demoqa.com/text-box';
const reporter = new TestReporter();
const client = new McpClient();

// 保存测试过程中创建的资源，用于清理
let testTabId = null;
let testTabId2 = null;

async function run() {
    console.log('mcp-chrome Test Suite\n');

    // ==================== 启动 ====================

    console.log('[Setup] Starting MCP Server...');
    await client.start();

    console.log('[Setup] Initializing MCP protocol...');
    await client.initialize();

    // ==================== 1. browse ====================

    console.log('\n1. browse');

    // 1.1 list
    try {
        const result = parseToolResult(await client.callTool('browse', { action: 'list' }));
        if (result?.success && Array.isArray(result.targets)) {
            reporter.pass('browse list');
        } else {
            reporter.fail('browse list', `Unexpected: ${JSON.stringify(result)}`);
        }
    } catch (e) {
        reporter.fail('browse list', e);
    }

    // 1.2 open (creates a new tab and navigates)
    try {
        const result = parseToolResult(await client.callTool(
            'browse',
            { action: 'open', url: TEST_URL, wait: 'load' },
        ));
        if (result?.success) {
            reporter.pass('browse open');
        } else {
            reporter.fail('browse open', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('browse open', e);
    }

    // 找到刚打开的 tab
    try {
        const listResult = parseToolResult(await client.callTool('browse', { action: 'list' }));
        const demoTab = listResult?.targets?.find(t => t.url?.includes('demoqa.com'));
        if (demoTab) {
            testTabId = demoTab.targetId;
            console.log(`  [info] Test tab: ${testTabId}`);
        }
    } catch { /* ignore */
    }

    // 1.3 attach（后台模式）
    if (testTabId) {
        try {
            const result = parseToolResult(await client.callTool('browse', { action: 'attach', targetId: testTabId }));
            if (result?.success && result.activated === false) {
                reporter.pass('browse attach (background)');
            } else {
                reporter.fail('browse attach (background)', JSON.stringify(result));
            }
        } catch (e) {
            reporter.fail('browse attach (background)', e);
        }

        // 1.4 attach（前台）
        try {
            const result = parseToolResult(
                await client.callTool('browse', { action: 'attach', targetId: testTabId, activate: true }));
            if (result?.success && result.activated === true) {
                reporter.pass('browse attach (activate)');
            } else {
                reporter.fail('browse attach (activate)', JSON.stringify(result));
            }
        } catch (e) {
            reporter.fail('browse attach (activate)', e);
        }
    }

    // 1.5 refresh
    try {
        const result = parseToolResult(await client.callTool('browse', { action: 'refresh', wait: 'load' }));
        if (result?.success) {
            reporter.pass('browse refresh');
        } else {
            reporter.fail('browse refresh', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('browse refresh', e);
    }

    // ==================== 2. extract ====================

    console.log('\n2. extract');

    // 2.1 text
    try {
        const result = parseToolResult(await client.callTool('extract', { type: 'text' }));
        if (result?.success && result.content?.length > 0) {
            reporter.pass('extract text');
        } else {
            reporter.fail('extract text', `Empty or failed: ${JSON.stringify(result)?.slice(0, 200)}`);
        }
    } catch (e) {
        reporter.fail('extract text', e);
    }

    // 2.2 screenshot
    try {
        const rawResult = await client.callTool('extract', { type: 'screenshot' });
        const content = rawResult?.content?.[0];
        if (content?.type === 'image' && content.data?.length > 100) {
            reporter.pass('extract screenshot');
        } else {
            reporter.fail('extract screenshot', 'No image data');
        }
    } catch (e) {
        reporter.fail('extract screenshot', e);
    }

    // 2.3 state (accessibility tree)
    try {
        const result = parseToolResult(await client.callTool('extract', { type: 'state' }));
        if (result?.success && result.state?.pageContent?.length > 0) {
            reporter.pass('extract state');
        } else {
            reporter.fail('extract state', `Empty: ${JSON.stringify(result)?.slice(0, 200)}`);
        }
    } catch (e) {
        reporter.fail('extract state', e);
    }

    // ==================== 3. input ====================

    console.log('\n3. input');

    // 3.1 type（在 #userName 输入框输入）
    try {
        // 先找到输入框并点击
        const result = parseToolResult(await client.callTool('input', {
            events: [
                { type: 'mousemove', target: { css: '#userName' } },
                { type: 'mousedown', button: 'left' },
                { type: 'mouseup', button: 'left' },
                { type: 'type', text: 'Test User' },
            ],
        }));
        if (result?.success) {
            reporter.pass('input type');
        } else {
            reporter.fail('input type', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('input type', e);
    }

    // 3.2 wheel（滚动页面）
    try {
        const result = parseToolResult(await client.callTool('input', {
            events: [{ type: 'wheel', deltaY: 300 }],
        }));
        if (result?.success) {
            reporter.pass('input wheel');
        } else {
            reporter.fail('input wheel', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('input wheel', e);
    }

    // 3.3 keydown/keyup
    try {
        const result = parseToolResult(await client.callTool('input', {
            events: [
                { type: 'keydown', key: 'Tab' },
                { type: 'keyup', key: 'Tab' },
            ],
        }));
        if (result?.success) {
            reporter.pass('input keydown/keyup');
        } else {
            reporter.fail('input keydown/keyup', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('input keydown/keyup', e);
    }

    // 3.4 select（选中页面文本）
    try {
        const result = parseToolResult(await client.callTool('input', {
            events: [{ type: 'select', find: 'Full Name' }],
        }));
        if (result?.success) {
            reporter.pass('input select');
        } else {
            reporter.fail('input select', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('input select', e);
    }

    // 3.5 replace（在输入框中替换文本）
    try {
        // 先输入文本
        await client.callTool('input', {
            events: [
                { type: 'click', target: { css: '#userName' } },
                { type: 'type', text: 'Hello World' },
            ],
        });
        // 查找并替换
        const result = parseToolResult(await client.callTool('input', {
            events: [{ type: 'replace', find: 'World', text: 'MCP', target: { css: '#userName' } }],
        }));
        if (result?.success) {
            reporter.pass('input replace');
        } else {
            reporter.fail('input replace', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('input replace', e);
    }

    // ==================== 4. evaluate ====================

    console.log('\n4. evaluate');

    // 4.1 precise 模式
    try {
        const result = parseToolResult(await client.callTool('evaluate', {
            script: 'document.title',
            mode: 'precise',
        }));
        if (result?.success && result.result) {
            reporter.pass('evaluate precise');
        } else {
            reporter.fail('evaluate precise', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('evaluate precise', e);
    }

    // 4.2 stealth 模式（demoqa 不太可能有 CSP）
    try {
        const result = parseToolResult(await client.callTool('evaluate', {
            script: '1 + 1',
            mode: 'stealth',
        }));
        if (result?.success) {
            reporter.pass('evaluate stealth');
        } else {
            // CSP 错误也算预期行为
            if (result?.error?.code === 'CSP_BLOCKED') {
                reporter.pass('evaluate stealth (CSP blocked as expected)');
            } else {
                reporter.fail('evaluate stealth', JSON.stringify(result));
            }
        }
    } catch (e) {
        reporter.fail('evaluate stealth', e);
    }

    // ==================== 5. wait ====================

    console.log('\n5. wait');

    // 5.1 time
    try {
        const start = Date.now();
        const result = parseToolResult(await client.callTool('wait', { for: 'time', ms: 500 }));
        const elapsed = Date.now() - start;
        if (result?.success && elapsed >= 400) {
            reporter.pass('wait time');
        } else {
            reporter.fail('wait time', `elapsed=${elapsed}ms, result=${JSON.stringify(result)}`);
        }
    } catch (e) {
        reporter.fail('wait time', e);
    }

    // 5.2 idle
    try {
        const result = parseToolResult(await client.callTool('wait', { for: 'idle', timeout: 5000 }));
        if (result?.success) {
            reporter.pass('wait idle');
        } else {
            reporter.fail('wait idle', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('wait idle', e);
    }

    // ==================== 6. logs ====================

    console.log('\n6. logs');

    // 6.1 console
    try {
        const result = parseToolResult(await client.callTool('logs', { type: 'console' }));
        if (result?.success) {
            reporter.pass('logs console');
        } else {
            reporter.fail('logs console', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('logs console', e);
    }

    // ==================== 7. cookies ====================

    console.log('\n7. cookies');

    // 7.1 get
    try {
        const result = parseToolResult(await client.callTool('cookies', {
            action: 'get',
            url: 'https://demoqa.com',
        }));
        if (result?.success) {
            reporter.pass('cookies get');
        } else {
            reporter.fail('cookies get', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('cookies get', e);
    }

    // 7.2 set
    try {
        const result = parseToolResult(await client.callTool('cookies', {
            action: 'set',
            name: 'mcp_test',
            value: 'test_value',
            url: 'https://demoqa.com',
        }));
        if (result?.success) {
            reporter.pass('cookies set');
        } else {
            reporter.fail('cookies set', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('cookies set', e);
    }

    // 7.3 delete
    try {
        const result = parseToolResult(await client.callTool('cookies', {
            action: 'delete',
            name: 'mcp_test',
            url: 'https://demoqa.com',
        }));
        if (result?.success) {
            reporter.pass('cookies delete');
        } else {
            reporter.fail('cookies delete', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('cookies delete', e);
    }

    // ==================== 8. manage ====================

    console.log('\n8. manage');

    // 8.1 inputMode 查询
    try {
        const result = parseToolResult(await client.callTool('manage', { action: 'inputMode' }));
        if (result?.success && result.currentMode) {
            reporter.pass(`manage inputMode (current: ${result.currentMode})`);
        } else {
            reporter.fail('manage inputMode', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('manage inputMode', e);
    }

    // 8.2 emulate 列出设备
    try {
        const result = parseToolResult(await client.callTool('manage', { action: 'emulate' }));
        if (result?.success && result.availableDevices?.length > 0) {
            reporter.pass('manage emulate (list devices)');
        } else {
            reporter.fail('manage emulate (list devices)', JSON.stringify(result));
        }
    } catch (e) {
        reporter.fail('manage emulate (list devices)', e);
    }

    // ==================== 9. 多 tab 并行 ====================

    console.log('\n9. multi-tab');

    // 9.1 打开第二个 tab
    try {
        const result = parseToolResult(await client.callTool('browse', {
            action: 'open',
            url: 'https://demoqa.com/buttons',
            wait: 'load',
        }));
        if (result?.success) {
            reporter.pass('multi-tab: open second tab');
        } else {
            reporter.fail('multi-tab: open second tab', JSON.stringify(result));
        }

        // 获取第二个 tab ID
        const listResult = parseToolResult(await client.callTool('browse', { action: 'list' }));
        const buttonsTab = listResult?.targets?.find(t => t.url?.includes('buttons'));
        if (buttonsTab) {
            testTabId2 = buttonsTab.targetId;
            console.log(`  [info] Second tab: ${testTabId2}`);
        }
    } catch (e) {
        reporter.fail('multi-tab: open second tab', e);
    }

    // 9.2 用 tabId 分别提取两个 tab 的文本
    if (testTabId && testTabId2) {
        try {
            // 先 attach 回第一个 tab
            await client.callTool('browse', { action: 'attach', targetId: testTabId });

            const text1 = parseToolResult(await client.callTool('extract', { type: 'text', tabId: testTabId }));
            const text2 = parseToolResult(await client.callTool('extract', { type: 'text', tabId: testTabId2 }));

            const content1 = text1?.content || '';
            const content2 = text2?.content || '';

            if (content1.includes('Text Box') && content2.includes('Button')) {
                reporter.pass('multi-tab: extract text from different tabs');
            } else {
                reporter.fail(
                    'multi-tab: extract text from different tabs',
                    `Tab1 has "Text Box": ${content1.includes('Text Box')}, Tab2 has "Button": ${content2.includes(
                        'Button')}`,
                );
            }
        } catch (e) {
            reporter.fail('multi-tab: extract text from different tabs', e);
        }
    } else {
        reporter.skip('multi-tab: extract text', 'Tab IDs not available');
    }

    // 9.3 检查 managed 字段
    try {
        const listResult = parseToolResult(await client.callTool('browse', { action: 'list' }));
        const managedTabs = listResult?.targets?.filter(t => t.managed === true);
        if (managedTabs?.length > 0) {
            reporter.pass(`multi-tab: managed field (${managedTabs.length} managed tabs)`);
        } else {
            reporter.fail('multi-tab: managed field', 'No tabs with managed=true');
        }
    } catch (e) {
        reporter.fail('multi-tab: managed field', e);
    }

    // ==================== 10. 清理 ====================

    console.log('\n10. cleanup');

    // 关闭测试 tab
    if (testTabId2) {
        try {
            await client.callTool('manage', { action: 'closePage', targetId: testTabId2 });
            reporter.pass('cleanup: close second tab');
        } catch (e) {
            reporter.fail('cleanup: close second tab', e);
        }
    }

    if (testTabId) {
        try {
            await client.callTool('manage', { action: 'closePage', targetId: testTabId });
            reporter.pass('cleanup: close test tab');
        } catch (e) {
            reporter.fail('cleanup: close test tab', e);
        }
    }

    // ==================== 总结 ====================

    const allPassed = reporter.summary();
    await client.close();
    process.exit(allPassed ? 0 : 1);
}

run().catch(async (e) => {
    console.error('\nFatal error:', e);
    await client.close();
    process.exit(1);
});
