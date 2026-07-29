// Device-local project library (IndexedDB).
//
// Local projects live ONLY on this device — switching devices means starting
// fresh unless the project was first uploaded to a Cloud Cowork space. Media
// bytes are already device-local (webmedia.ts); this stores the project JSON,
// its metadata, and the user's local folders alongside them.
//
// One-time migration: the project library used to live in the Supabase
// `projects` table. On first run the first device to open CLAIMS any existing
// server rows into its local store and then deletes them server-side, so a
// user's old projects don't keep following them to every device they log in on.
import type { Project, ProjectMeta, ProjectRec } from '@shared/types'
import { getSupabase } from '../cloud/supabase'

const DB_NAME = 'ec-localprojects'
const P_STORE = 'projects'
const F_STORE = 'folders'
const THUMB_MAX = 400_000 // same cap the old server row enforced on the thumb data-URL
const CLAIM_FLAG = 'ec_local_projects_claimed'

interface PRow {
  id: string
  name: string
  thumb: string
  project: Project | null
  createdAt: number
  updatedAt: number
  folderId: string | null
}
interface FRow {
  id: string
  name: string
  createdAt: number
}

/** A device-local folder for organising local projects. */
export interface LocalFolder {
  id: string
  name: string
}

let dbPromise: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = (): void => {
        const d = req.result
        if (!d.objectStoreNames.contains(P_STORE)) d.createObjectStore(P_STORE, { keyPath: 'id' })
        if (!d.objectStoreNames.contains(F_STORE)) d.createObjectStore(F_STORE, { keyPath: 'id' })
      }
      req.onsuccess = (): void => resolve(req.result)
      req.onerror = (): void => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function allRows<T>(store: string): Promise<T[]> {
  return db().then(
    (d) =>
      new Promise<T[]>((resolve) => {
        if (!d) return resolve([])
        try {
          const rq = d.transaction(store, 'readonly').objectStore(store).getAll()
          rq.onsuccess = (): void => resolve((rq.result as T[]) || [])
          rq.onerror = (): void => resolve([])
        } catch {
          resolve([])
        }
      })
  )
}
function getRow<T>(store: string, id: string): Promise<T | null> {
  return db().then(
    (d) =>
      new Promise<T | null>((resolve) => {
        if (!d) return resolve(null)
        try {
          const rq = d.transaction(store, 'readonly').objectStore(store).get(id)
          rq.onsuccess = (): void => resolve((rq.result as T) ?? null)
          rq.onerror = (): void => resolve(null)
        } catch {
          resolve(null)
        }
      })
  )
}
function putRow(store: string, value: unknown): Promise<void> {
  return db().then(
    (d) =>
      new Promise<void>((resolve) => {
        if (!d) return resolve()
        try {
          const tx = d.transaction(store, 'readwrite')
          tx.objectStore(store).put(value)
          tx.oncomplete = (): void => resolve()
          tx.onabort = (): void => resolve()
          tx.onerror = (): void => resolve()
        } catch {
          resolve()
        }
      })
  )
}
function delRow(store: string, id: string): Promise<void> {
  return db().then(
    (d) =>
      new Promise<void>((resolve) => {
        if (!d) return resolve()
        try {
          const tx = d.transaction(store, 'readwrite')
          tx.objectStore(store).delete(id)
          tx.oncomplete = (): void => resolve()
          tx.onabort = (): void => resolve()
          tx.onerror = (): void => resolve()
        } catch {
          resolve()
        }
      })
  )
}

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `p_${Date.now().toString(36)}_${Math.round(Math.random() * 1e9).toString(36)}`
  }
}

function toMeta(r: PRow): ProjectMeta {
  return {
    id: r.id,
    name: r.name,
    thumb: r.thumb || '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    folderId: r.folderId ?? null
  }
}

// ---- one-time claim of the old server-side library ------------------------
let claimDone = false
async function claimServerProjectsOnce(): Promise<void> {
  if (claimDone) return
  try {
    if (localStorage.getItem(CLAIM_FLAG) === '1') {
      claimDone = true
      return
    }
  } catch {
    /* localStorage blocked — try the claim anyway (harmless if empty) */
  }
  try {
    const sb = getSupabase()
    const { data, error } = await sb.from('projects').select('id,name,thumb,project,created_at,updated_at')
    if (error) return // signed-out / transient — retry on the next list
    const rows = (data as Array<Record<string, unknown>>) || []
    for (const r of rows) {
      const id = String(r.id)
      if (await getRow<PRow>(P_STORE, id)) continue // don't clobber a local edit
      await putRow(P_STORE, {
        id,
        name: (r.name as string) || 'Untitled',
        thumb: (r.thumb as string) ?? '',
        project: (r.project as Project | null) ?? null,
        createdAt: new Date(r.created_at as string).getTime(),
        updatedAt: new Date(r.updated_at as string).getTime(),
        folderId: null
      } satisfies PRow)
    }
    if (rows.length) {
      // Move, not copy: drop the server rows so they don't resurface elsewhere.
      try {
        await sb
          .from('projects')
          .delete()
          .in(
            'id',
            rows.map((r) => String(r.id))
          )
      } catch {
        /* leave them; the claim flag below still prevents re-import loops */
      }
    }
    try {
      localStorage.setItem(CLAIM_FLAG, '1')
    } catch {
      /* ignore */
    }
    claimDone = true
  } catch {
    /* retry on the next list */
  }
}

// ---- projects (window.api surface) ----------------------------------------
export async function localListProjects(): Promise<ProjectMeta[]> {
  await claimServerProjectsOnce()
  const rows = await allRows<PRow>(P_STORE)
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  return rows.map(toMeta)
}

export async function localCreateProject(
  name: string,
  project: Project | null
): Promise<{ id: string; name: string }> {
  const id = newId()
  const now = Date.now()
  const nm = name || 'Untitled'
  await putRow(P_STORE, { id, name: nm, thumb: '', project, createdAt: now, updatedAt: now, folderId: null } satisfies PRow)
  return { id, name: nm }
}

export async function localGetProject(id: string): Promise<ProjectRec | null> {
  const r = await getRow<PRow>(P_STORE, id)
  if (!r) return null
  return { ...toMeta(r), project: r.project ?? null }
}

export async function localSaveProject(
  id: string,
  patch: { name?: string; project?: Project; thumb?: string; folderId?: string | null }
): Promise<void> {
  const r = await getRow<PRow>(P_STORE, id)
  if (!r) return
  if (patch.name !== undefined) r.name = patch.name
  if (patch.project !== undefined) r.project = patch.project
  if (patch.thumb !== undefined && patch.thumb.length <= THUMB_MAX) r.thumb = patch.thumb
  if (patch.folderId !== undefined) r.folderId = patch.folderId
  r.updatedAt = Date.now()
  await putRow(P_STORE, r)
}

export async function localDeleteProject(id: string): Promise<void> {
  await delRow(P_STORE, id)
}

// ---- local folders --------------------------------------------------------
export async function localListFolders(): Promise<LocalFolder[]> {
  const rows = await allRows<FRow>(F_STORE)
  rows.sort((a, b) => a.createdAt - b.createdAt)
  return rows.map((f) => ({ id: f.id, name: f.name }))
}

export async function localCreateFolder(name: string): Promise<LocalFolder> {
  const id = newId()
  const nm = name.trim() || 'New folder'
  await putRow(F_STORE, { id, name: nm, createdAt: Date.now() } satisfies FRow)
  return { id, name: nm }
}

export async function localRenameFolder(id: string, name: string): Promise<void> {
  const r = await getRow<FRow>(F_STORE, id)
  if (!r) return
  r.name = name.trim() || r.name
  await putRow(F_STORE, r)
}

/** Delete a folder; any projects inside it fall back to "unfiled". */
export async function localDeleteFolder(id: string): Promise<void> {
  const rows = await allRows<PRow>(P_STORE)
  for (const r of rows) {
    if (r.folderId === id) {
      r.folderId = null
      await putRow(P_STORE, r)
    }
  }
  await delRow(F_STORE, id)
}

export async function localMoveProjectToFolder(projectId: string, folderId: string | null): Promise<void> {
  const r = await getRow<PRow>(P_STORE, projectId)
  if (!r) return
  r.folderId = folderId
  await putRow(P_STORE, r)
}
