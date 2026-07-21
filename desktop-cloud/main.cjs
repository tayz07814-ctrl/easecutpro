// EaseCutPro — cloud desktop shell (macOS first; works on Win/Linux too).
//
// This is NOT the offline/native Electron build (src/main). It is a thin native
// window that loads the CLOUD web app (the same one deployed to easecutpro.com).
// All compute is server-side (Supabase transcription + OpenRouter judge); import
// and export happen on-device through the web app's own browser file APIs — the
// native window just provides downloads/open dialogs. No ffmpeg/whisper binaries.
//
// Override the target with EASECUT_APP_URL (e.g. a preview deployment or a local
// `npm run dev:cloud` server) — handy for testing before release.

const { app, BrowserWindow, shell, session, Menu } = require('electron')

const APP_URL = process.env.EASECUT_APP_URL || 'https://easecutpro.com'
let APP_ORIGIN = 'https://easecutpro.com'
try {
  APP_ORIGIN = new URL(APP_URL).origin
} catch {
  /* keep default */
}

// Keep the app's own origin and OAuth/Supabase sign-in flows INSIDE the app so
// auth redirects return correctly; send unrelated links to the system browser.
function shouldKeepInApp(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  return (
    u.origin === APP_ORIGIN ||
    u.host.endsWith('supabase.co') ||
    u.host === 'accounts.google.com' ||
    u.host === 'appleid.apple.com' ||
    u.host === 'github.com'
  )
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'EaseCutPro',
    backgroundColor: '#0b0b0f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })

  win.loadURL(APP_URL)

  // target=_blank / new-window requests: keep auth flows in-app, links external.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldKeepInApp(url)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Full-page navigations to a foreign origin (e.g. a docs link) → system browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!shouldKeepInApp(url)) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  return win
}

app.whenReady().then(() => {
  // Grant media/clipboard permissions, but ONLY to our trusted app origin.
  session.defaultSession.setPermissionRequestHandler((wc, _permission, cb) => {
    const from = (wc && wc.getURL()) || ''
    cb(from.startsWith(APP_ORIGIN))
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// macOS keeps apps alive when all windows close; other platforms quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function menuTemplate() {
  const isMac = process.platform === 'darwin'
  return [
    // The app menu (About / Hide / Quit) — required for standard macOS shortcuts.
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' }, // Cut/Copy/Paste/Select-All
    { role: 'viewMenu' }, // Reload / Zoom / Fullscreen / DevTools
    { role: 'windowMenu' }
  ]
}
