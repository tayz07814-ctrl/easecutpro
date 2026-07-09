/// <reference types="vite/client" />

// Cloud build (Vercel + Supabase) configuration — baked in at build time.
interface ImportMetaEnv {
  /** '1' in the cloud build (vite.config.cloud.ts); unset in Electron/self-host builds. */
  readonly VITE_CLOUD?: string
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
