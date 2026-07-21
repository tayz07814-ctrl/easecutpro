# EaseCutPro — Cloud Desktop Shell (macOS)

A thin native window around the **cloud web app** (the same one at easecutpro.com).
All compute is server-side (Supabase transcription + OpenRouter judge). Import and
export happen **on-device** through the web app's own browser file dialogs. There
are **no** ffmpeg/whisper/Parakeet binaries here — this is deliberately not the
offline/native Electron build (`src/main`), which stays untouched for Windows.

## What's here
- `main.cjs` — the Electron main process: opens a native window, loads
  `EASECUT_APP_URL` (default `https://easecutpro.com`), keeps sign-in flows in-app,
  sends other links to the system browser, provides standard macOS menus.
- `entitlements.mac.plist` — hardened-runtime entitlements (JIT, network, file dialogs).
- `../electron-builder.cloud.json` — the packaging config (output → `release-cloud/`).

## Prerequisites (on a Mac)
1. **Node 20+** and this repo's deps: `npm ci` at the repo root (Electron comes with it).
2. **Xcode Command Line Tools**: `xcode-select --install`.
3. **App icon**: put a macOS icon at `icons/icon.icns` (1024×1024 source).
   Generate one from a PNG with `iconutil`, or just drop a 1024×1024 `icons/icon.png`
   and electron-builder will convert it.
4. **For a signed/notarized build only**: an Apple Developer account ($99/yr) and a
   "Developer ID Application" certificate in your login keychain.

## Try it instantly (no build, no signing)
```bash
npm run start:mac
# or point it at a preview / local server:
EASECUT_APP_URL=https://<your-preview>.vercel.app npm run start:mac
```

## Build a Mac app
Unsigned `.app` for quick local testing (opens with right-click → Open):
```bash
npm run dist:mac:dir      # → release-cloud/mac/EaseCutPro.app
```

Signed + notarized `.dmg` for distribution:
```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID="YOURTEAMID"
export CSC_NAME="Developer ID Application: Your Name (YOURTEAMID)"
npm run dist:mac          # → release-cloud/EaseCutPro-<version>.dmg (+ .zip for auto-update)
```
electron-builder signs with `CSC_NAME` and notarizes automatically when the
`APPLE_*` vars are present.

## Notes
- **Universal binary** (Apple Silicon + Intel): add `--universal`, i.e.
  `npm run dist:mac -- --universal`. Default builds for the host arch.
- **Auth**: email / magic-link works as-is. Google/Apple OAuth pop-ups are kept
  in-app by `main.cjs`; if a provider blocks the embedded flow, tell me and I'll
  switch that provider to a system-browser + deep-link callback.
- **Windows/Linux**: the same shell runs there too
  (`electron-builder -c electron-builder.cloud.json --win`), but your partner's
  offline Windows build (`npm run dist`) is separate and unaffected.
