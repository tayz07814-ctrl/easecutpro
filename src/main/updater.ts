// Auto-update for the packaged Windows app.
//
// Without this, every fix shipped means asking creators to find and re-download
// a 230MB installer — so in practice most of them never get it. electron-updater
// reads the feed electron-builder publishes (GitHub Releases; see the `publish`
// block in package.json), downloads a new version in the background and installs
// it on quit.
//
// Deliberately quiet: the check is best-effort and NEVER blocks or interrupts
// editing. A creator mid-render must not be prompted, and an unreachable feed is
// a no-op rather than an error dialog. The only user-visible moment is a small
// prompt AFTER a version has already downloaded, offering to restart.

import { createRequire } from 'node:module'
import { app, dialog, type BrowserWindow } from 'electron'
import type { AppUpdater } from 'electron-updater'

// electron-updater is CommonJS and the main bundle is ESM (deps are externalised
// by electron-vite, so the import survives to runtime verbatim). A named import
// typechecks and builds, then throws on launch:
//   SyntaxError: Named export 'autoUpdater' not found
// which crashes the app before the window ever opens. createRequire is the
// interop that actually works in an ESM main process.
const requireCjs = createRequire(import.meta.url)
const { autoUpdater } = requireCjs('electron-updater') as { autoUpdater: AppUpdater }

/** Wait a little after launch so updating never competes with opening a project. */
const FIRST_CHECK_DELAY_MS = 15_000
/** Long-running sessions re-check occasionally; a video edit can last hours. */
const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000

let wired = false

export function initAutoUpdate(getWindow: () => BrowserWindow | null): void {
  // Only a packaged, signed-feed build has anything to update from. In dev the
  // updater throws ("no published versions"), which is noise, not information.
  if (wired || !app.isPackaged) return
  wired = true

  autoUpdater.autoDownload = true
  // Never install underneath someone mid-edit — we ask first, then quit-install.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('error', (e) => {
    // Offline, rate-limited, or no release yet. Not worth a dialog.
    console.warn('[updater]', (e as Error)?.message ?? e)
  })

  autoUpdater.on('update-downloaded', async (info) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `EaseCutPro ${info.version} is ready to install.`,
      detail: 'Your work is saved automatically. The update installs when you restart.'
    })
    if (response === 0) {
      // isSilent=false so the NSIS UI shows; isForceRunAfter=true reopens the app.
      setImmediate(() => autoUpdater.quitAndInstall(false, true))
    }
  })

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
  setTimeout(check, FIRST_CHECK_DELAY_MS)
  setInterval(check, RECHECK_EVERY_MS)
}
