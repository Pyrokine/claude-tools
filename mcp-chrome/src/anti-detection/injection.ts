/**
 * 反检测注入脚本
 *
 * 在页面加载前注入，用于：
 * - 移除 navigator.webdriver
 * - 清理 CDP 痕迹
 * - 模拟真实浏览器指纹
 *
 * 覆盖范围：navigator.webdriver、cdc_*、UA、若干 WebGL vendor/renderer、Chrome runtime
 * 不覆盖：Canvas/Audio/Font 指纹、TLS 层指纹、CDP attach 横幅、扩展存在性探测
 * 警告：禁止依赖此能力绕过商业 anti-bot 服务
 *
 * 模式：
 * - safe: 基础修补（移除 webdriver、清理 CDP 痕迹、UA 标识修正）
 * - aggressive: 在 safe 基础上追加 plugins、languages、chrome、permissions、WebGL 修补
 */

type StealthMode = 'safe' | 'aggressive'

// 公共 body：三块基础修补，base 与 full 共享
const COMMON_BODY = `
  // ============================================
  // 1. 移除 navigator.webdriver
  // ============================================
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });

    // 删除 webdriver 检测相关属性
    delete navigator.__proto__.webdriver;
  } catch {
    // 静默处理，避免污染站点控制台
  }

  // ============================================
  // 2. 清理 CDP 痕迹
  // ============================================
  try {
    // 清理 window.cdc_* 变量（Chrome DevTools 特征）
    const cdcKeys = Object.keys(window).filter(key => key.startsWith('cdc_'));
    for (const key of cdcKeys) {
      delete window[key];
    }

    // 清理 document.cdc_* 变量
    const docCdcKeys = Object.keys(document).filter(key => key.startsWith('cdc_'));
    for (const key of docCdcKeys) {
      delete document[key];
    }
  } catch {
    // 静默处理
  }

  // ============================================
  // 3. 修改 navigator.userAgent 中的 Headless 标识
  // ============================================
  try {
    const originalUserAgent = navigator.userAgent;
    if (originalUserAgent.includes('HeadlessChrome')) {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => originalUserAgent.replace('HeadlessChrome', 'Chrome'),
        configurable: true,
      });
    }
  } catch {
    // 静默处理
  }
`

// aggressive 追加 body：plugins / languages / chrome / permissions / WebGL
const AGGRESSIVE_EXTRA_BODY = `
  // ============================================
  // 4. 模拟真实插件列表
  // ============================================
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          {
            name: 'Chrome PDF Plugin',
            filename: 'internal-pdf-viewer',
            description: 'Portable Document Format',
          },
          {
            name: 'Chrome PDF Viewer',
            filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
            description: '',
          },
          {
            name: 'Native Client',
            filename: 'internal-nacl-plugin',
            description: '',
          },
        ];

        // 模拟 PluginArray 行为
        const pluginArray = Object.create(PluginArray.prototype);
        plugins.forEach((plugin, i) => {
          const p = Object.create(Plugin.prototype);
          Object.defineProperties(p, {
            name: { value: plugin.name },
            filename: { value: plugin.filename },
            description: { value: plugin.description },
            length: { value: 0 },
          });
          pluginArray[i] = p;
        });
        Object.defineProperty(pluginArray, 'length', { value: plugins.length });
        pluginArray.item = (i) => pluginArray[i];
        pluginArray.namedItem = (name) => plugins.find(p => p.name === name);
        pluginArray.refresh = () => {};

        return pluginArray;
      },
      configurable: true,
    });
  } catch {
    // 静默处理
  }

  // ============================================
  // 5. 模拟真实语言设置
  // ============================================
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      configurable: true,
    });
  } catch {
    // 静默处理
  }

  // ============================================
  // 6. 修复 Chrome 特有属性
  // ============================================
  try {
    // chrome.runtime 检测
    const chromeDescriptor = Object.getOwnPropertyDescriptor(window, 'chrome');
    if (window.chrome === undefined && (!chromeDescriptor || chromeDescriptor.configurable)) {
      Object.defineProperty(window, 'chrome', {
        value: {
          runtime: {},
          loadTimes: () => ({}),
          csi: () => ({}),
          app: {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          },
        },
        configurable: true,
      });
    }
  } catch {
    // 静默处理
  }

  // ============================================
  // 7. 修复 Permissions API
  // ============================================
  try {
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => {
        // 对于 notifications 权限，返回 denied 而非 prompt
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return originalQuery.call(navigator.permissions, parameters);
      };
    }
  } catch {
    // 静默处理
  }

  // ============================================
  // 8. 修复 WebGL 渲染器信息
  // ============================================
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      // UNMASKED_VENDOR_WEBGL
      if (parameter === 37445) {
        return 'Intel Inc.';
      }
      // UNMASKED_RENDERER_WEBGL
      if (parameter === 37446) {
        return 'Intel Iris OpenGL Engine';
      }
      return getParameter.call(this, parameter);
    };

    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) {
        return 'Intel Inc.';
      }
      if (parameter === 37446) {
        return 'Intel Iris OpenGL Engine';
      }
      return getParameter2.call(this, parameter);
    };
  } catch {
    // 静默处理
  }
`

function wrapStealthBody(body: string): string {
    return `
(function() {
  'use strict';

  // 如果已经注入过，跳过
  if (window.__mcp_chrome_injected__) return;
  window.__mcp_chrome_injected__ = true;
${body}})();
`
}

const baseStealthScript = wrapStealthBody(COMMON_BODY)
const fullStealthScript = wrapStealthBody(COMMON_BODY + AGGRESSIVE_EXTRA_BODY)

/**
 * 获取反检测注入脚本
 */
export function getAntiDetectionScript(mode: StealthMode = 'safe'): string {
    return mode === 'aggressive' ? fullStealthScript : baseStealthScript
}
