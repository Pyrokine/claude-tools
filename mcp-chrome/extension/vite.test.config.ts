import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// noinspection JSUnusedGlobalSymbols -- npm test passes this entry to Vite with --config
export default defineConfig({
    build: {
        outDir: 'node_modules/.cache/mcp-chrome-tests',
        emptyOutDir: true,
        minify: false,
        lib: {
            entry: resolve(__dirname, 'test/native-pointer.test.js'),
            formats: ['es'],
            fileName: () => 'finding-regressions.test.js',
        },
        rollupOptions: {
            external: ['node:assert/strict', 'node:test', 'node:vm'],
        },
    },
})
