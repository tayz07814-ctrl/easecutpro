// Stage C — read-only projects adapter for the new Dashboard (screen 1a).
// Wraps the SAME sources HomeScreen uses (projectsApi + store batchJobs) and
// shapes them into the design's DashCard[] view-model. Adds only a client-side
// search filter (no existing search action). No new project/persistence state.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import { IS_CLOUD } from '../../platform'
import { authLogout } from '../../webapi'
import { cloudLogout } from '../../cloud/auth'
import {
  listProjects,
  createProject,
  getProject,
  deleteProject,
  saveProject,
  type ProjectMeta
} from '../../projectsApi'
import type { BatchJob } from '../../store'
import type { DashCard } from '../mock'

function relDate(t: number): string {
  const diff = Date.now() - t
  if (diff < 60_000) return 'Edited just now'
  if (diff < 3_600_000) return `Edited ${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `Edited ${Math.floor(diff / 3_600_000)} h ago`
  if (diff < 172_800_000) return 'Edited yesterday'
  return `Edited ${new Date(t).toLocaleDateString()}`
}

/** ProjectMeta (+ any live batch job) → the design's card view-model. */
function toCard(p: ProjectMeta, job?: BatchJob): DashCard {
  if (job && (job.status === 'queued' || job.status === 'processing')) {
    // Batch jobs carry a step label, not a numeric %, so the bar is coarse
    // (queued/processing) and the honest status rides the footer sub-line.
    return { kind: 'processing', title: p.name, sub: job.step || 'Processing…', percent: job.status === 'processing' ? 60 : 10 }
  }
  if (!p.thumb) {
    return { kind: 'failed', title: p.name, edited: relDate(p.updatedAt), duration: '' }
  }
  return { kind: 'video', title: p.name, edited: relDate(p.updatedAt), duration: '', thumb: '16:9' }
}

export interface DashboardModel {
  cards: DashCard[]
  metas: ProjectMeta[] // filtered, card-aligned (offset by the leading "new" tile)
  loading: boolean
  query: string
  setQuery: (q: string) => void
  email: string
  open: (id: string) => Promise<void>
  create: () => Promise<void>
  batch: () => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export function useProjects(): DashboardModel {
  const email = useStore((s) => s.user?.email ?? '')
  const batchJobs = useStore((s) => s.batchJobs)
  const openProjectRecord = useStore((s) => s.openProjectRecord)
  const freshProject = useStore((s) => s.freshProject)
  const runBatchClean = useStore((s) => s.runBatchClean)
  const setUser = useStore((s) => s.setUser)
  const setView = useStore((s) => s.setView)

  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  async function refresh(silent = false): Promise<void> {
    if (!silent) setLoading(true)
    setProjects(await listProjects())
    if (!silent) setLoading(false)
  }
  useEffect(() => {
    void refresh()
  }, [])

  const doneCount = batchJobs.filter((j) => j.status === 'done' || j.status === 'error').length
  useEffect(() => {
    if (batchJobs.length) void refresh(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchJobs.length, doneCount])

  const jobById = useMemo(() => {
    const m: Record<string, BatchJob> = {}
    for (const j of batchJobs) m[j.projectId] = j
    return m
  }, [batchJobs])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
  }, [projects, query])

  const cards = useMemo<DashCard[]>(
    () => [{ kind: 'new' }, ...filtered.map((p) => toCard(p, jobById[p.id]))],
    [filtered, jobById]
  )

  async function open(id: string): Promise<void> {
    const rec = await getProject(id)
    if (rec) openProjectRecord({ id: rec.id, name: rec.name, project: rec.project })
  }
  async function create(): Promise<void> {
    const empty = freshProject()
    empty.name = 'Untitled project'
    const rec = await createProject(empty.name, empty)
    openProjectRecord({ id: rec.id, name: rec.name, project: empty })
  }
  async function batch(): Promise<void> {
    const items = await window.api.openMediaDialogMulti()
    if (items.length) void runBatchClean(items)
  }
  async function rename(id: string, name: string): Promise<void> {
    const n = name.trim()
    const cur = projects.find((p) => p.id === id)
    if (!n || !cur || n === cur.name) return
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, name: n } : p)))
    await saveProject(id, { name: n })
  }
  async function remove(id: string): Promise<void> {
    await deleteProject(id)
    void refresh()
  }
  async function logout(): Promise<void> {
    if (IS_CLOUD) await cloudLogout()
    else await authLogout()
    setUser(null)
    setView('auth')
  }

  return { cards, metas: filtered, loading, query, setQuery, email, open, create, batch, rename, remove, logout, refresh }
}
