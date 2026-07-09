import { useEffect, useState } from 'react'
import { useStore, type BatchJob } from '../store'
import { IS_WEB, IS_CLOUD } from '../platform'
import { authLogout } from '../webapi'
import { cloudLogout } from '../cloud/auth'
import { listProjects, createProject, getProject, deleteProject, saveProject, type ProjectMeta } from '../projectsApi'

function fmtDate(t: number): string {
  const d = new Date(t)
  const now = Date.now()
  const diff = now - t
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString()
}

export default function HomeScreen(): JSX.Element {
  const user = useStore((s) => s.user)
  const setUser = useStore((s) => s.setUser)
  const setView = useStore((s) => s.setView)
  const openProjectRecord = useStore((s) => s.openProjectRecord)
  const freshProject = useStore((s) => s.freshProject)
  const batchJobs = useStore((s) => s.batchJobs)
  const runBatchClean = useStore((s) => s.runBatchClean)
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [batching, setBatching] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)

  async function commitRename(id: string, name: string): Promise<void> {
    setRenaming(null)
    const n = name.trim()
    const cur = projects.find((p) => p.id === id)
    if (!n || !cur || n === cur.name) return
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, name: n } : p)))
    await saveProject(id, { name: n })
  }

  async function refresh(silent = false): Promise<void> {
    if (!silent) setLoading(true)
    setProjects(await listProjects())
    if (!silent) setLoading(false)
  }
  useEffect(() => {
    refresh()
  }, [])

  // Refresh the grid when batch jobs appear (new cards) or finish (updated thumbs).
  const doneCount = batchJobs.filter((j) => j.status === 'done' || j.status === 'error').length
  useEffect(() => {
    if (batchJobs.length) refresh(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchJobs.length, doneCount])

  async function batchClean(): Promise<void> {
    if (batching) return
    const items = await window.api.openMediaDialogMulti()
    if (!items.length) return
    setBatching(true)
    void runBatchClean(items).finally(() => setBatching(false))
  }

  async function newProject(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const empty = freshProject()
      empty.name = 'Untitled project'
      const rec = await createProject(empty.name, empty)
      openProjectRecord({ id: rec.id, name: rec.name, project: empty })
    } finally {
      setBusy(false)
    }
  }

  async function open(id: string): Promise<void> {
    const rec = await getProject(id)
    if (rec) openProjectRecord({ id: rec.id, name: rec.name, project: rec.project })
  }

  async function del(id: string, e: React.MouseEvent): Promise<void> {
    e.stopPropagation()
    if (!window.confirm('Delete this project? This cannot be undone.')) return
    await deleteProject(id)
    refresh()
  }

  async function logout(): Promise<void> {
    if (IS_CLOUD) await cloudLogout()
    else await authLogout()
    setUser(null)
    setView('auth')
  }

  const jobById: Record<string, BatchJob> = {}
  for (const j of batchJobs) jobById[j.projectId] = j
  const activeJobs = batchJobs.filter((j) => j.status === 'queued' || j.status === 'processing').length

  return (
    <div className="home">
      <header className="home-top">
        <div className="home-brand">EaseCut<span>Pro</span></div>
        <span className="spacer" />
        {IS_WEB && (
          <>
            <span className="home-user muted">{user?.email}</span>
            <button onClick={logout}>Log out</button>
          </>
        )}
      </header>

      <div className="home-body">
        <div className="home-headrow">
          <h2>Your projects</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="home-new"
              onClick={batchClean}
              disabled={batching}
              title="Add multiple videos — each becomes a project with fillers, repeats & silences auto-removed"
            >
              {batching ? '🧹 Cleaning…' : '🧹 Batch Video Cleaner'}
            </button>
            <button className="home-new" onClick={newProject} disabled={busy}>＋ New project</button>
          </div>
        </div>

        {activeJobs > 0 && (
          <div className="muted" style={{ marginBottom: 12, fontSize: 13 }}>
            🧹 Batch cleaning {activeJobs} video{activeJobs > 1 ? 's' : ''} — transcribing, removing fillers &
            silences. Finished ones are ready to open below.
          </div>
        )}

        {loading ? (
          <div className="muted home-empty">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="home-empty">
            <div className="muted">No projects yet.</div>
            <button className="home-new" onClick={newProject} disabled={busy}>＋ Create your first project</button>
          </div>
        ) : (
          <div className="home-grid">
            <button className="proj-card proj-new" onClick={newProject} disabled={busy}>
              <div className="proj-new-plus">＋</div>
              <div className="proj-new-label">New project</div>
            </button>
            {projects.map((p) => {
              const job = jobById[p.id]
              const processing = !!job && (job.status === 'queued' || job.status === 'processing')
              return (
              <div className="proj-card" key={p.id} onClick={() => open(p.id)}>
                <div className="proj-thumb" style={{ position: 'relative' }}>
                  {p.thumb ? <img src={p.thumb} alt="" /> : <span className="proj-thumb-icon">🎬</span>}
                  {processing && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(0,0,0,0.55)',
                        color: '#fff',
                        fontSize: 12,
                        textAlign: 'center',
                        padding: 6
                      }}
                    >
                      <span>⏳ {job?.step}</span>
                    </div>
                  )}
                </div>
                <div className="proj-meta">
                  {renaming === p.id ? (
                    <input
                      className="proj-rename"
                      defaultValue={p.name}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => commitRename(p.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        else if (e.key === 'Escape') setRenaming(null)
                      }}
                    />
                  ) : (
                    <div
                      className="proj-name"
                      title="Double-click to rename"
                      onDoubleClick={(e) => { e.stopPropagation(); setRenaming(p.id) }}
                    >
                      {p.name}
                    </div>
                  )}
                  <div className="proj-date muted">
                    {job && job.status === 'processing'
                      ? `⏳ ${job.step}`
                      : job && job.status === 'queued'
                      ? '⏳ Queued'
                      : job && job.status === 'error'
                      ? `⚠ ${job.error || 'Failed'}`
                      : job && job.status === 'done'
                      ? '✓ Cleaned'
                      : fmtDate(p.updatedAt)}
                  </div>
                </div>
                <button className="proj-del" onClick={(e) => del(p.id, e)} title="Delete">🗑</button>
              </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
