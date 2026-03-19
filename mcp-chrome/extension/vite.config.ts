import {crx} from '@crxjs/vite-plugin'
import {defineConfig} from 'vite'
import manifest from './manifest.json'

export default defineConfig({
                                plugins: [
                                    crx({ manifest }),
                                ],
                                build: {
                                    outDir: 'dist',
                                    emptyOutDir: true,
                                    rollupOptions: {
                                        input: {
                                            popup: 'src/popup/popup.html',
                                        },
                                    },
                                },
                            })
