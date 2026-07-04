// Standalone Vite dev server for the timeline renderer preview (browser-visible,
// no Electron/IPC). Run via `.claude/launch.json` -> "timeline-preview".
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./preview/timeline', import.meta.url)),
  resolve: {
    alias: {
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url))
    }
  },
  plugins: [react()],
  server: { port: 5199, strictPort: true },
  clearScreen: false
})
