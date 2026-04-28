import { crx } from '@crxjs/vite-plugin'
import { defineConfig } from 'vite'
import manifest from './manifest.json'

export default defineConfig({
    plugins: [crx({ manifest })],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        // page-scripts 中的函数通过 chrome.scripting.executeScript({ func }) 注入页面
        // 序列化时只取函数体，压缩后的模块级变量引用在页面上下文不存在
        minify: false,
        rollupOptions: {
            input: {
                popup: 'src/popup/popup.html',
            },
        },
    },
})
