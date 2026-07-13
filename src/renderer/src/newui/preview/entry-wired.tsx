// Dev-only Stage C verification harness. NOT shipped. Seeds a stubbed window.api
// + real Zustand store with realistic data, then mounts a WIRED screen so it can
// be screenshotted / smoke-tested against the real store (not mock data).
import { createRoot } from 'react-dom/client'
import '../newui.css'
import { useStore } from '../../store'
import Dashboard from '../screens/Dashboard'

const min = 60_000
const svg = (c: string): string =>
  `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='320' height='180' fill='%23${c}'/></svg>`

const now = Date.now()
const metas = [
  { id: 'p1', name: 'Morning routine — bedroom take', thumb: svg('2a2d36'), createdAt: 0, updatedAt: now - 36 * min },
  { id: 'p2', name: 'GRWM hook — v2', thumb: svg('26323f'), createdAt: 0, updatedAt: now - 60 * min },
  { id: 'p3', name: 'Kitchen b-roll batch', thumb: svg('2a2d36'), createdAt: 0, updatedAt: now - 90 * min },
  { id: 'p4', name: 'Podcast clip — episode 12', thumb: '', createdAt: 0, updatedAt: now - 3 * 60 * min },
  { id: 'p5', name: 'Meal-prep voiceover', thumb: svg('222831'), createdAt: 0, updatedAt: now - 26 * 60 * min },
  { id: 'p6', name: 'Apartment tour — draft', thumb: svg('242a33'), createdAt: 0, updatedAt: now - 50 * 60 * min }
]

const w = window as unknown as { api: Record<string, unknown>; __calls: string[] }
w.__calls = []
const rec = (name: string) => (...args: unknown[]): unknown => {
  w.__calls.push(name + ':' + JSON.stringify(args).slice(0, 80))
  if (name === 'listProjects') return Promise.resolve(metas)
  if (name === 'getProject') return Promise.resolve({ id: args[0], name: 'x', project: null })
  if (name === 'createProject') return Promise.resolve({ id: 'new', name: args[0] })
  if (name === 'openMediaDialogMulti') return Promise.resolve([])
  return Promise.resolve()
}
w.api = {
  listProjects: rec('listProjects'),
  getProject: rec('getProject'),
  createProject: rec('createProject'),
  deleteProjectRecord: rec('deleteProjectRecord'),
  saveProjectRecord: rec('saveProjectRecord'),
  openMediaDialogMulti: rec('openMediaDialogMulti')
}

useStore.setState({
  user: { id: 'u', email: 'tayz07814@gmail.com' },
  batchJobs: [{ projectId: 'p3', name: 'Kitchen b-roll batch', status: 'processing', step: 'Uploading media…' }]
})

const screen = new URLSearchParams(location.search).get('screen') || '1a'
const MAP: Record<string, () => JSX.Element> = { '1a': Dashboard }
const Comp = MAP[screen] || Dashboard
createRoot(document.getElementById('root') as HTMLElement).render(
  <div id="screen">
    <Comp />
  </div>
)
