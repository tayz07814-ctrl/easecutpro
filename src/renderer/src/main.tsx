import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AuthScreen from './components/AuthScreen'
import HomeScreen from './components/HomeScreen'
import { useStore } from './store'
import { IS_WEB, IS_CLOUD, IS_NEW_UI } from './platform'
import { redactForCreator } from './safeError'
import { installWebApi, authMe } from './webapi'
import { installCloudApi } from './cloud/api'
import { cloudAuthMe } from './cloud/auth'
import { supabaseConfigured } from './cloud/supabase'
import { probeServer } from './offline'
import { serializeProjectLite, saveProject } from './projectsApi'
import './styles.css'
// Design-system foundation (tokens + self-hosted fonts). Scoped under
// [data-ec-ui="new"] — inert unless the flag below marks <html>.
import './design/tokens.css'
// P2: desktop shell + toolbar + panel chrome (scoped; visual-only).
import './design/shell.css'
// P3: Retake Cleaner panel presentation (scoped; visual-only).
import './design/panel.css'
// P4: Silence Settings sheet (scoped; visual-only).
import './design/silence.css'
// P5: editor shell + top bar (scoped; visual-only).
import './design/editor.css'

// Opt-in premium redesign: mark the root so the scoped design CSS applies. OFF
// by default → legacy UI unchanged. Set once, before first paint.
if (IS_NEW_UI) document.documentElement.setAttribute('data-ec-ui', 'new')

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
      // Beta ship (cloud): mask everything confidential — creators see a redacted
      // one-liner, NO stack/paths/URLs/vendor names. Desktop/self-host: full detail.
      const msg = IS_CLOUD
        ? redactForCreator(message) || 'Something went wrong — please try again.'
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

function Root(): JSX.Element {
  const view = useStore((s) => s.view)

  // Bootstrap (web): probe the backend first. If it's unreachable (bundled
  // Capacitor app with no server, PC asleep, no network) drop into OFFLINE mode —
  // skip auth entirely and open a local editor session, because manual editing
  // (import / split / trim / cut / preview) and on-device export need no server.
  // Only when the backend answers do we run the normal auth → home/login flow.
  useEffect(() => {
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
        if (!cancelled) useStore.setState({ user, view: user ? 'home' : 'auth' })
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
      if (st.view !== 'editor' || !st.currentProjectId) return
      if (st.project === prev.project) return
      useStore.setState({ saveState: 'saving' })
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        const s = useStore.getState()
        if (s.view !== 'editor' || !s.currentProjectId) return
        try {
          const serialized = serializeProjectLite(s.project)
          await saveProject(s.currentProjectId, {
            project: serialized,
            name: s.project.name,
            thumb: s.thumbnails[0]?.url || ''
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

  if (view === 'loading') return <div className="auth"><div className="muted">Loading…</div></div>
  if (view === 'auth') return <AuthScreen />
  if (view === 'home') return <HomeScreen />
  return <App />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
