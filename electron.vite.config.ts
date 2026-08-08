import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // Keep npm deps (e.g. `openai`) OUT of the bundle — its source contains an
    // `import … from 'undici'` example inside a string that breaks electron-vite's
    // __dirname shim injection. Externalized deps are loaded from node_modules.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // Load VITE_SUPABASE_* from the repo-root .env (same file build:cloud uses)
    // so the desktop renderer can reach the cloud backend (auth + edge AI).
    envDir: __dirname,
    define: {
      // Desktop-cloud hybrid: native ffmpeg media + Supabase auth/edge AI.
      // Baked here (not .env) — every Electron build IS the hybrid.
      'import.meta.env.VITE_DESKTOP_CLOUD': JSON.stringify('1')
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()]
  }
})
