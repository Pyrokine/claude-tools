import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
    build: {
        outDir: 'node_modules/.cache/mcp-chrome-tests',
        emptyOutDir: true,
        minify: false,
        lib: {
            entry: resolve(__dirname, 'test/finding-regressions.test.js'),
            formats: ['es'],
            fileName: () => 'finding-regressions.test.js',
        },
        rollupOptions: {
            external: ['node:assert/strict', 'node:test', 'node:vm'],
        },
    },
})
