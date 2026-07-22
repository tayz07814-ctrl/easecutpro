import type { CapacitorConfig } from '@capacitor/cli'

// EaseCutPro — Capacitor (Android) wrapper.
//
// OFFLINE / BUNDLED mode: the built cloud web app (`dist-cloud`) is packaged INTO
// the APK and served locally, so the editor boots and runs with NO connection —
// import / split / trim / cut / preview / on-device (WebCodecs → hardware-codec)
// export all work offline. The ONLINE features (login, project sync, Cut Lord,
// captions) reach Supabase directly at its absolute URL when the device has a
// connection, and degrade gracefully otherwise (see offline.ts).
//
// The bundle is built with VITE_FORCE_NEWUI=1 (no query string on localhost) and
// VITE_CAPACITOR=1 (connectivity = navigator.onLine, not a same-origin ping).
const config: CapacitorConfig = {
  appId: 'com.easecutpro.tals',
  appName: 'EaseCutPro',
  webDir: 'dist-cloud',
  android: {
    allowMixedContent: false
  }
}

export default config
