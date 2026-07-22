import type { CapacitorConfig } from '@capacitor/cli'

// EaseCutPro — Capacitor (Android) wrapper.
//
// TEST-APK MODE (easecut0.01): loads the LIVE 0.01 web preview via server.url, so
// the installed app is exactly the build you test in the browser — the new mobile
// UI plus the working Supabase/edge backend — just fullscreen with no browser
// chrome. Requires a network connection. `webDir` is only the boot splash
// (capacitor-www) shown until the remote URL loads.
//
// FUTURE / OFFLINE MODE (kept for reference): drop `server` and set
// `webDir: 'out/renderer'` to bundle the renderer and boot straight into the
// offline editor (import / split / trim / cut / preview / on-device export work
// with no connection; STT + AI light up when a server is reachable — see
// src/renderer/src/offline.ts).
const PREVIEW_URL = 'https://easecutpro-git-easecut001-acme-1x2.vercel.app/?newui=1'

const config: CapacitorConfig = {
  appId: 'com.easecutpro.tals',
  appName: 'EaseCutPro',
  webDir: 'capacitor-www',
  server: {
    url: PREVIEW_URL,
    cleartext: false
  }
}

export default config
