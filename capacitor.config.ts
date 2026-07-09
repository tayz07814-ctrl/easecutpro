import type { CapacitorConfig } from '@capacitor/cli'

// EaseCutPro — Capacitor (Android) wrapper.
//
// webDir points at the offline-capable renderer build (out/renderer). The app
// is BUNDLED (no server.url), so it boots straight into the offline editor:
// import / split / trim / cut / preview / on-device export all work with no
// connection; the transcription + AI cut engines light up when a server is
// reachable (see src/renderer/src/offline.ts).
const config: CapacitorConfig = {
  appId: 'com.easecutpro.tals',
  appName: 'EaseCutPro',
  webDir: 'out/renderer'
}

export default config
