import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AuthScreen from './components/AuthScreen'
import HomeScreen from './components/HomeScreen'
import { useStore } from './store'
import { IS_WEB, IS_CLOUD } from './platform'
import { installWebApi, authMe } from './webapi'
import { installCloudApi } from './cloud/api'
import { cloudAuthMe } from './cloud/auth'
import { supabaseConfigured } from './cloud/supabase'
import { probeServer } from './offline'
import { serializeProjectLite, saveProject } from './projectsApi'
import './styles.css'

if (IS_WEB) {
  if (IS_CLOUD) installCloudApi()
  else installWebApi()
  // Surface failed async ops in the status bar (and clear a stuck spinner).
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && (e.reason.message || String(e.reason))) || 'Unknown error'
    useStore.setState({ job: { active: false, percent: 0, message: `Error: ${msg}` } })
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
