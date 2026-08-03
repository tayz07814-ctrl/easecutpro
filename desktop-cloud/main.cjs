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
const fs = require('fs')
const path = require('path')

const APP_URL = process.env.EASECUT_APP_URL || 'https://easecutpro.com'
/** The signed-in app lives here; `/` is the public marketing landing. */
const APP_PATH = '/earlybetatesters'

// Where the window was when it last closed. A desktop app should reopen where you
// left it — landing on the "get started" marketing page every launch is a website
// behaviour, not an app one. Stored next to the app's other user data.
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json')
}
function readLastPath() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    return typeof s.lastPath === 'string' ? s.lastPath : ''
  } catch {
    return ''
  }
}
function writeLastPath(p) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify({ lastPath: p }), 'utf8')
  } catch {
    /* not worth failing a launch over */
  }
}

// Full-window splash, shown from the first paint until the app has actually
// rendered. Without it the window opens on ~seconds of black while the bundle
// downloads, parses and mounts. Inlined as a data URL so it needs no packaged
// asset and paints instantly.
const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b0b0f;overflow:hidden}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#6e6e85}
.ring{width:34px;height:34px;border-radius:50%;border:2.5px solid rgba(124,107,255,.18);
  border-top-color:#7c6bff;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style><div class="wrap"><div class="ring"></div><div>Starting EaseCutPro…</div></div>`)}`
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
    // The File/Edit/View/Window strip is a stock Electron menu bar and reads as a
    // 1990s app bolted above the editor. Hidden on Windows/Linux (Alt still
    // reveals it); macOS keeps its menu because the OS owns that bar and the
    // standard shortcuts live there.
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })

  // Reopen wherever we were — but only inside the app itself, never a stale
  // legal/marketing page, and never an auth callback URL with a one-shot token.
  const last = readLastPath()
  const startPath = last === APP_PATH || last.startsWith(`${APP_PATH}/`) ? last : ''
  const target = startPath ? new URL(startPath, APP_URL).toString() : APP_URL

  // Splash first so the window has something to show immediately, then the real
  // app loads underneath it and replaces it once it has painted a frame.
  const splash = new BrowserWindow({
    parent: win,
    modal: false,
    show: false,
    frame: false,
    resizable: false,
    transparent: false,
    backgroundColor: '#0b0b0f',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  const fitSplash = () => {
    if (splash.isDestroyed() || win.isDestroyed()) return
    const b = win.getContentBounds()
    splash.setBounds(b)
  }
  splash.loadURL(SPLASH)
  splash.once('ready-to-show', () => {
    if (splash.isDestroyed()) return
    fitSplash()
    splash.showInactive()
  })
  win.on('resize', fitSplash)
  win.on('move', fitSplash)

  let splashGone = false
  const dropSplash = () => {
    if (splashGone) return
    splashGone = true
    win.off('resize', fitSplash)
    win.off('move', fitSplash)
    if (!splash.isDestroyed()) splash.destroy()
    if (!win.isDestroyed()) win.focus()
  }
  // Whichever comes first: the app painted, or we've waited long enough that a
  // stuck splash would be worse than whatever is behind it (offline, say — the
  // error page needs to be reachable).
  win.webContents.once('did-finish-load', () => setTimeout(dropSplash, 350))
  win.webContents.once('did-fail-load', dropSplash)
  setTimeout(dropSplash, 20000)

  win.loadURL(target)

  // Remember the in-app path across launches (both real navigations and the
  // SPA's own history.pushState routing).
  const remember = (url) => {
    try {
      const u = new URL(url)
      if (u.origin === APP_ORIGIN) writeLastPath(u.pathname)
    } catch {
      /* ignore */
    }
  }
  win.webContents.on('did-navigate', (_e, url) => remember(url))
  win.webContents.on('did-navigate-in-page', (_e, url) => remember(url))

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

  // Only macOS needs an application menu; elsewhere it is pure chrome we don't want.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate(menuTemplate()) : null)
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
