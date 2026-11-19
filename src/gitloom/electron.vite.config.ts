import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // vizWorker: tree-sitter parsing for 变更可视化 runs in worker_threads (out/main/vizWorker.js)
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), vizWorker: resolve('src/main/viz/worker.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [react()],
    build: {
      chunkSizeWarningLimit: 8000,
      rollupOptions: {
        output: {
          // Keep heavy viz/editor stacks out of the App entry so 自动化 can open without them.
          manualChunks(id) {
            if (id.includes('node_modules/@xyflow') || id.includes('node_modules/xyflow')) return 'xyflow'
            if (id.includes('node_modules/monaco-editor') || id.includes('node_modules/@monaco-editor')) return 'monaco'
            if (id.includes('node_modules/elkjs')) return 'elk'
          }
        }
      }
    }
  }
})
