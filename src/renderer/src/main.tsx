import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { createPortal } from 'react-dom'
import AuthScreen from './components/AuthScreen'
import LandingScreen from './landing/LandingScreen'
import { EcPromptHost } from './ui/ecPrompt'
import LegalPage from './landing/LegalPage'
import AccountPanelHost from './newui/screens/AccountPanelHost'
import PricingModalHost from './newui/screens/PricingModal'
import { useStore, firstVideoSourcePath } from './store'
import { IS_WEB, IS_CLOUD, IS_DESKTOP_CLOUD } from './platform'
import { safeErrMessage } from './safeError'
import { installWebApi, authMe } from './webapi'
import { installCloudApi } from './cloud/api'
import { initDesktopCloud } from './cloud/desktopHybrid'
import { cloudAuthMe } from './cloud/auth'
import { supabaseConfigured } from './cloud/supabase'
import { probeServer } from './offline'
import { serializeProjectLite, saveProject } from './projectsApi'
import Dashboard from './newui/screens/Dashboard'
import MobileDashboard from './newui/screens/MobileDashboard'
import AdminDashboard from './newui/screens/AdminDashboard'
import Editor from './newui/screens/Editor'
import MobileEditor from './newui/screens/MobileEditor'
import CutProgressOverlay from './newui/screens/CutProgressOverlay'
import { useIsMobile } from './useMobile'
import './styles.css'
// Design-system foundation (tokens + self-hosted fonts). Scoped under
// [data-ec-ui="new"] — inert unless the flag below marks <html>.
import './design/tokens.css'
// P2: desktop shell + toolbar + panel chrome (scoped; visual-only).
import './design/shell.css'
// P3: Retake Cleaner panel presentation (scoped; visual-only).
import './design/panel.css'
// P4: Silence Settings sheet (scoped; visual-only).
// P5: editor shell + top bar (scoped; visual-only).
import './design/editor.css'
// P6: media library (scoped; visual-only).
import './design/media.css'
import './newui/newui.css'

// Opt-in premium redesign (P1–P6, gated by VITE_NEW_EASECUT_UI): mark the root
// so the scoped design CSS applies. OFF by default → legacy UI unchanged. This
// attempt is dormant in production (the env var is unset); kept inert, not removed.
document.documentElement.setAttribute('data-ec-ui', 'new')

// The Stage A–C new UI, now the default on every host; ?newui=0 (persisted to

// Job-bar recorder. ONE `job` slot is written by many producers (every IPC
// progress event plus each action's own set()), and a progress bar that
// restarts mid-run is always a fight between two of them. Recording every
// transition centrally — rather than instrumenting each writer — is what makes
// that diagnosable. Bounded; readable from DevTools as window.__jobLog.
{
  const log: { t: number; kind?: string; percent: number; active: boolean; msg?: string }[] = []
  ;(window as unknown as { __jobLog?: typeof log }).__jobLog = log
  let prev = useStore.getState().job
  useStore.subscribe((s) => {
    if (s.job === prev) return
    prev = s.job
    if (log.length >= 400) log.shift()
    log.push({
      t: Math.round(performance.now()),
      kind: s.job.kind,
      percent: s.job.percent,
      active: s.job.active,
      msg: s.job.message
    })
  })
}

// Desktop-cloud hybrid: settings sync boot. The AI routing itself happens at
// the call sites via aiApi() (window.api is contextBridge read-only).
if (IS_DESKTOP_CLOUD) initDesktopCloud()

if (IS_WEB) {
  if (IS_CLOUD) installCloudApi()
  else installWebApi()
  // ---- Visible error surface (mobile Safari has no console you can open) ----
  // A dismissible on-screen box showing the message + stack, so a crash in Cut
  // Lord, export, or waveform decode SHOWS what failed instead of silently dying.
  // Built in vanilla DOM so it works even if React itself has thrown. Deduped so
  // the same error doesn't stack. Reachable from anywhere via window.__ecError.
  const seenErr = new Set<string>()
  const showErr = (label: string, err: unknown): void => {
    try {
      const e = err as Error | undefined
      // Full detail ALWAYS goes to the console (developer remote-debugging), never
      // gated — only what renders on-screen is masked.
      try {
        console.error('[ec]', label, err)
      } catch {
        /* console unavailable */
      }
      // Safari's Error.stack lists frames but OMITS the message line, so always
      // show the message FIRST — otherwise we see where it threw, not WHAT failed.
      const message = (e && e.message) || String(err)
      const stack = (e && e.stack) || ''
      // Beta ship (cloud): a clean creator-safe message or an opaque code — NO
      // stack/paths/URLs/vendor/model names ever. Desktop/self-host: full detail.
      const msg = IS_CLOUD
        ? safeErrMessage(err)
        : stack && !stack.startsWith(message)
          ? `${message}\n${stack}`
          : stack || message
      if (seenErr.has(label + '|' + msg)) return
      seenErr.add(label + '|' + msg)
      let box = document.getElementById('ec-err')
      if (!box) {
        box = document.createElement('div')
        box.id = 'ec-err'
        box.style.cssText =
          'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;max-height:45vh;overflow:auto;' +
          'background:#2a0d12;color:#ffdada;border:1px solid #ff5b6e;border-radius:10px;padding:10px 12px;' +
          'font:12px/1.45 ui-monospace,Menlo,monospace;box-shadow:0 8px 30px rgba(0,0,0,.55)'
        document.body.appendChild(box)
      }
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;justify-content:space-between;gap:8px;font-weight:700;margin-bottom:4px'
      const h = document.createElement('span')
      h.textContent = '⚠︎ ' + label
      const x = document.createElement('button')
      x.textContent = 'dismiss'
      x.style.cssText = 'background:none;border:1px solid #ff5b6e;color:#ffdada;border-radius:6px;padding:2px 8px'
      x.onclick = () => box && box.remove()
      row.append(h, x)
      const pre = document.createElement('pre')
      pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:0'
      pre.textContent = msg
      box.append(row, pre)
    } catch {
      /* never let the reporter itself throw */
    }
  }
  ;(window as unknown as { __ecError?: typeof showErr }).__ecError = showErr
  window.addEventListener('error', (e) => showErr('Error', e.error || e.message))
  // Surface failed async ops in the status bar (clear a stuck spinner) AND on-screen.
  window.addEventListener('unhandledrejection', (e) => {
    // Clear a stuck spinner; keep the raw reason OFF the creator's screen in cloud.
    useStore.setState({
      job: { active: false, percent: 0, message: IS_CLOUD ? 'Something went wrong — please try again.' : `Error: ${(e.reason && (e.reason.message || String(e.reason))) || 'Unknown error'}` }
    })
    showErr('Async error', e.reason)
  })

  // ---- Crash breadcrumb ----
  // An iOS out-of-memory kill RELOADS the tab with no error event, so a long op
  // (Cut Lord / export) just vanishes — nothing above can catch it. Persist the
  // active job; if a reload finds one still "running", the previous run died
  // mid-way (on iPhone that's almost always OOM). Report which STAGE it reached.
  try {
    const prev = sessionStorage.getItem('ec.activeJob')
    if (prev) {
      const j = JSON.parse(prev) as { kind?: string; percent?: number; message?: string; active?: boolean }
      if (j && j.active) {
        showErr(
          'Last run crashed — likely out of memory',
          new Error(
            `${j.kind || 'Job'} reached ${j.percent ?? 0}% ("${j.message || ''}") and the tab reloaded itself. ` +
              `On iPhone that almost always means it ran out of memory on this clip.`
          )
        )
      }
    }
    sessionStorage.removeItem('ec.activeJob')
  } catch {
    /* sessionStorage unavailable — skip the breadcrumb */
  }
  let lastJob: unknown = null
  useStore.subscribe((s) => {
    if (s.job === lastJob) return
    lastJob = s.job
    try {
      if (s.job?.active)
        sessionStorage.setItem(
          'ec.activeJob',
          JSON.stringify({ kind: s.job.kind, percent: s.job.percent, message: s.job.message, active: true })
        )
      else sessionStorage.removeItem('ec.activeJob')
    } catch {
      /* ignore */
    }
  })
}

// Admin console (owner-only): a hard-to-guess path renders the userbase dashboard
// instead of the app (every path serves index.html on Vercel, so the client
// routes it). The path is only obscurity — real security is the server-side
// is_app_admin() check every admin_* RPC enforces, so a non-admin who finds the
// URL still sees only "not authorized". Cloud build only (needs the Supabase
// session). `?admin=1` also works as a dev fallback.
const ADMIN_PATH = '/tayztals32614jz'
const IS_ADMIN_ROUTE =
  IS_CLOUD &&
  typeof window !== 'undefined' &&
  (window.location.pathname.replace(/\/+$/, '') === ADMIN_PATH ||
    new URLSearchParams(window.location.search).has('admin'))

type RouteView = 'landing' | 'auth' | 'home' | 'terms' | 'privacy' | 'refund'

// Cloud routing on top of the view-state machine. It's all one SPA (Vercel
// serves index.html on every path), so this just maps the pathname to a view:
//   /                        → public landing for signed-out visitors; authenticated ⇒ app
//   /earlybetatesters        → the app; signed-out ⇒ auth screen
//   /terms | /privacy | /refund → legal pages
// `navigate` keeps URL and view in sync for the marketing/legal links.
const APP_PATH = '/earlybetatesters'

function viewForPath(path: string, user: { id: string } | null): RouteView {
  if (path === '/terms') return 'terms'
  if (path === '/privacy') return 'privacy'
  if (path === '/refund') return 'refund'
  if (path === APP_PATH || path.startsWith(`${APP_PATH}/`)) return user ? 'home' : 'auth'
  // The root is the public marketing page for signed-out visitors, but an
  // authenticated visitor should never be sent back to marketing after a
  // refresh or by opening the canonical domain.
  if (path === '/' && user) return 'home'
  return 'landing'
}

function navigate(path: string): void {
  if (window.location.pathname !== path) window.history.pushState({}, '', path)
  useStore.setState({ view: viewForPath(path, useStore.getState().user) })
  window.scrollTo(0, 0)
}

function Root(): JSX.Element {
  const view = useStore((s) => s.view)
  const isMobile = useIsMobile()

  if (IS_ADMIN_ROUTE) return <AdminDashboard />

  // The new UI (Dashboard/Editor) never mounts the legacy <App/>, which is the
  // only place that calls store.init() — and init() is what subscribes to the
  // global progress stream (window.api.onProgress → job.percent). Without it,
  // Retake/transcribe/export progress events are emitted but never update the
  // bar (it just jumps from the action's own 1% to 100%). Register it once here.
  useEffect(() => {
    void useStore.getState().init()
  }, [])

  // Marketing/legal routes: keep the view in sync with the URL on back/forward.
  useEffect(() => {
    if (!IS_CLOUD) return
    const onPop = (): void =>
      useStore.setState({ view: viewForPath(window.location.pathname, useStore.getState().user) })
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Bootstrap (web): probe the backend first. If it's unreachable (bundled
  // Capacitor app with no server, PC asleep, no network) drop into OFFLINE mode —
  // skip auth entirely and open a local editor session, because manual editing
  // (import / split / trim / cut / preview) and on-device export need no server.
  // Only when the backend answers do we run the normal auth → home/login flow.
  useEffect(() => {
    // Desktop-cloud hybrid: same Supabase bootstrap as the cloud web build —
    // sign-in gate when online, local editor session when offline. Media stays
    // native either way; only auth + edge AI need the network. No SPA paths in
    // Electron, so the view is simply auth/home.
    if (IS_DESKTOP_CLOUD) {
      let cancelled = false
      ;(async () => {
        const online = supabaseConfigured() && navigator.onLine !== false
        if (cancelled) return
        useStore.getState().setServerAvailable(online)
        if (!online) {
          useStore.setState({ user: null, view: 'home' })
          return
        }
        try {
          const { user } = await cloudAuthMe()
          if (!cancelled) useStore.setState({ user, view: user ? 'home' : 'auth' })
        } catch {
          // Session probe failed — never strand the app on "Loading…".
          if (!cancelled) useStore.setState({ user: null, view: 'auth' })
        }
      })()
      return () => {
        cancelled = true
      }
    }
    if (!IS_WEB) return
    let cancelled = false
    ;(async () => {
      // Cloud build: the "backend" is Supabase, not the PC — reachability is
      // config + network. Unconfigured/offline still opens a local editor
      // session (manual editing + on-device export need no backend at all).
      if (IS_CLOUD) {
        const online = supabaseConfigured() && navigator.onLine !== false
        if (cancelled) return
        useStore.getState().setServerAvailable(online)
        if (!online) {
          useStore.setState({
            user: null,
            currentProjectId: null,
            project: useStore.getState().freshProject(),
            library: [],
            view: 'editor'
          })
          return
        }
        const { user } = await cloudAuthMe()
        if (!cancelled) {
          const atPublicRoot = window.location.pathname === '/'
          const nextPath = user && atPublicRoot ? APP_PATH : window.location.pathname
          if (nextPath !== window.location.pathname) window.history.replaceState({}, '', nextPath)
          useStore.setState({ user, view: viewForPath(nextPath, user) })
        }
        return
      }
      const online = await probeServer()
      if (cancelled) return
      useStore.getState().setServerAvailable(online)
      if (!online) {
        useStore.setState({
          user: null,
          currentProjectId: null,
          project: useStore.getState().freshProject(),
          library: [],
          view: 'editor'
        })
        return
      }
      try {
        const { user } = await authMe()
        if (!cancelled) useStore.setState({ user, view: user ? 'home' : 'auth' })
      } catch {
        // Reachable at probe but auth failed to load — treat as offline session.
        if (cancelled) return
        useStore.getState().setServerAvailable(false)
        useStore.setState({
          user: null,
          currentProjectId: null,
          project: useStore.getState().freshProject(),
          library: [],
          view: 'editor'
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Autosave the open project (desktop + web). On web this saves ONLY the small
  // project JSON — the media bytes autosave to THIS device (IndexedDB, written
  // at import) and upload lazily when the PC actually needs them (engines:
  // audio-only; PC export / explicit Save: full file). Ids that already have a
  // PC copy are swapped for their server paths, still with zero network.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = useStore.subscribe((st, prev) => {
      if (st.view !== 'editor' || (!st.currentProjectId && !st.coworkSession)) return
      if (st.project === prev.project) return
      useStore.setState({ saveState: 'saving' })
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        const s = useStore.getState()
        if (s.view !== 'editor') return
        // Cloud Cowork project: edits persist to R2 as THIS member's version, not
        // to the local `projects` table.
        if (s.coworkSession) {
          try {
            await useStore.getState().saveCoworkEdit()
            useStore.setState({ saveState: 'saved' })
          } catch {
            useStore.setState({ saveState: 'error' })
          }
          return
        }
        if (!s.currentProjectId) return
        try {
          // Dashboard thumbnail. openProjectRecord only eager-loads thumbnails for
          // legacy project.media; a doc-native project (clip dragged/clicked onto
          // the timeline, no project.media) leaves s.thumbnails empty and its card
          // read "Preview unavailable". Derive one here from the project's first
          // video source and cache it, so the very first save persists a thumbnail.
          let thumb = s.thumbnails[0]?.url || ''
          if (!thumb) {
            const src = firstVideoSourcePath(s.project)
            if (src) {
              try {
                const t = await window.api.thumbnails(src)
                if (t[0]?.url) {
                  thumb = t[0].url
                  useStore.setState({ thumbnails: t })
                }
              } catch {
                /* thumbnail generation is best-effort */
              }
            }
          }
          const serialized = serializeProjectLite(s.project)
          await saveProject(s.currentProjectId, {
            project: serialized,
            name: s.project.name,
            thumb
          })
          useStore.setState({ saveState: 'saved' })
        } catch {
          useStore.setState({ saveState: 'error' }) // next edit retries
        }
      }, 1500)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (view === 'loading') return <div className="auth"><div className="muted">Loading…</div>{createPortal(<CutProgressOverlay />, document.body)}</div>
  if (view === 'landing') return <LandingScreen onStartFree={() => navigate(APP_PATH)} onNavigate={navigate} />
  if (view === 'terms') return <LegalPage kind="terms" onNavigate={navigate} />
  if (view === 'privacy') return <LegalPage kind="privacy" onNavigate={navigate} />
  if (view === 'refund') return <LegalPage kind="refund" onNavigate={navigate} />
  if (view === 'auth') return <AuthScreen />
  if (view === 'home') return isMobile ? <MobileDashboard /> : <Dashboard />
  return isMobile ? <MobileEditor /> : <Editor />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Root />
    <AccountPanelHost />
    <PricingModalHost />
    {/* window.prompt() doesn't exist in Electron, so every naming flow asks here. */}
    <EcPromptHost />
  </React.StrictMode>
)
