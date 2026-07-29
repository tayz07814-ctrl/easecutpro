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
import {
  localListFolders,
  localCreateFolder,
  localRenameFolder,
  localDeleteFolder,
  localMoveProjectToFolder,
  type LocalFolder
} from '../../local/library'
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
  // Always a video card — a project without a cached thumbnail (not yet generated,
  // or truly media-less) shows a clean placeholder tile, not a "Preview unavailable"
  // error. A real thumbnail fills in as soon as one is generated + persisted.
  return { kind: 'video', title: p.name, edited: relDate(p.updatedAt), duration: '', thumb: '16:9', image: p.thumb || undefined }
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
  // device-local folders
  folders: LocalFolder[]
  selectedFolder: string | null
  setSelectedFolder: (id: string | null) => void
  folderCounts: { all: number; byId: Record<string, number> }
  createFolder: () => Promise<void>
  renameFolder: (id: string, curName: string) => Promise<void>
  removeFolder: (id: string) => Promise<void>
  moveToFolder: (projectId: string, folderId: string | null) => Promise<void>
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
  const [folders, setFolders] = useState<LocalFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  async function refresh(silent = false): Promise<void> {
    if (!silent) setLoading(true)
    const [ps, fs] = await Promise.all([listProjects(), localListFolders()])
    setProjects(ps)
    setFolders(fs)
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
    let list = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
    if (selectedFolder) list = list.filter((p) => (p.folderId ?? null) === selectedFolder)
    return list
  }, [projects, query, selectedFolder])

  const folderCounts = useMemo(() => {
    const byId: Record<string, number> = {}
    for (const p of projects) if (p.folderId) byId[p.folderId] = (byId[p.folderId] || 0) + 1
    return { all: projects.length, byId }
  }, [projects])

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
    // land it in the folder that's currently open, if any
    if (selectedFolder) await localMoveProjectToFolder(rec.id, selectedFolder)
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

  // ---- local folders --------------------------------------------------------
  async function createFolder(): Promise<void> {
    const name = window.prompt('New folder name')
    if (name == null || !name.trim()) return
    const f = await localCreateFolder(name)
    setFolders(await localListFolders())
    setSelectedFolder(f.id)
  }
  async function renameFolder(id: string, curName: string): Promise<void> {
    const name = window.prompt('Rename folder', curName)
    if (name == null || !name.trim()) return
    await localRenameFolder(id, name)
    setFolders(await localListFolders())
  }
  async function removeFolder(id: string): Promise<void> {
    if (!window.confirm('Delete this folder? Projects inside move back to All projects.')) return
    await localDeleteFolder(id)
    if (selectedFolder === id) setSelectedFolder(null)
    setFolders(await localListFolders())
    void refresh(true)
  }
  async function moveToFolder(projectId: string, folderId: string | null): Promise<void> {
    // optimistic — reflect immediately, then persist
    setProjects((ps) => ps.map((p) => (p.id === projectId ? { ...p, folderId } : p)))
    await localMoveProjectToFolder(projectId, folderId)
  }

  return {
    cards,
    metas: filtered,
    loading,
    query,
    setQuery,
    email,
    open,
    create,
    batch,
    rename,
    remove,
    logout,
    refresh,
    folders,
    selectedFolder,
    setSelectedFolder,
    folderCounts,
    createFolder,
    renameFolder,
    removeFolder,
    moveToFolder
  }
}
