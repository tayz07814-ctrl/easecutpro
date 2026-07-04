import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AuthScreen from './components/AuthScreen'
import HomeScreen from './components/HomeScreen'
import { useStore } from './store'
import { IS_WEB } from './platform'
import { installWebApi, authMe } from './webapi'
import { serializeProject, saveProject } from './projectsApi'
import './styles.css'

if (IS_WEB) {
  installWebApi()
  // Surface failed async ops in the status bar (and clear a stuck spinner).
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && (e.reason.message || String(e.reason))) || 'Unknown error'
    useStore.setState({ job: { active: false, percent: 0, message: `Error: ${msg}` } })
  })
}

function Root(): JSX.Element {
  const view = useStore((s) => s.view)

  // Bootstrap auth (web): who's logged in?
  useEffect(() => {
    if (!IS_WEB) return
    authMe().then(({ user }) => useStore.setState({ user, view: user ? 'home' : 'auth' }))
  }, [])

  // Autosave the open project (desktop + web). On web this also uploads any
  // browser-local media so the project reloads later.
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
          const serialized = await serializeProject(s.project)
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
