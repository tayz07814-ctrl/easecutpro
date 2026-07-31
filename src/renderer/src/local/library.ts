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

/** The signed-in user's id, or null when signed out. */
async function currentUid(): Promise<string | null> {
  try {
    const { data } = await getSupabase().auth.getUser()
    return data.user?.id ?? null
  } catch {
    return null // signed out, offline, or Supabase not configured
  }
}

/** One IndexedDB per account.
 *
 *  The library used to live in a single `ec-localprojects` database shared by
 *  everyone who ever signed in on this browser, so logging out and signing in as
 *  someone else showed the previous person's projects. A signed-out session gets
 *  its own bucket too, so a guest's work never lands in the next person's
 *  library either. */
function dbNameFor(uid: string | null): string {
  return uid ? `${DB_NAME}-${uid}` : `${DB_NAME}-guest`
}

function openNamed(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name, 1)
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
}

let dbPromise: Promise<IDBDatabase | null> | null = null
let dbUid: string | null = null
let dbOpened = false

async function db(): Promise<IDBDatabase | null> {
  const uid = await currentUid()
  // Re-resolve whenever the account changes, so a login switch inside one page
  // session cannot keep serving the previous user's handle.
  if (dbOpened && dbUid === uid && dbPromise) return dbPromise
  if (dbPromise) {
    const old = await dbPromise
    try {
      old?.close()
    } catch {
      /* already closed */
    }
  }
  dbUid = uid
  dbOpened = true
  await adoptLegacyLibraryOnce(uid)
  dbPromise = openNamed(dbNameFor(uid))
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

// ---- one-time adoption of the shared pre-scoping library ------------------
//
// Before the per-account split, every project on this device sat in one
// unscoped `ec-localprojects` database. Those rows carry no owner, so there is
// no way to know whose they are — but leaving them shared is the bug being
// fixed, and dropping them would delete real work.
//
// So the first account to open after this update adopts them, and the legacy
// database is DELETED immediately afterwards. That bounds the exposure to a
// single hand-off on a device that was already showing them to everyone, and
// guarantees no second account can ever see them.
const ADOPT_FLAG = 'ec_local_projects_adopted'

async function adoptLegacyLibraryOnce(uid: string | null): Promise<void> {
  try {
    if (localStorage.getItem(ADOPT_FLAG) === '1') return
  } catch {
    return // localStorage blocked: skip rather than risk repeated adoption
  }
  try {
    const legacy = await openNamed(DB_NAME)
    if (!legacy) return
    const read = <T>(store: string): Promise<T[]> =>
      new Promise((resolve) => {
        try {
          if (!legacy.objectStoreNames.contains(store)) return resolve([])
          const rq = legacy.transaction(store, 'readonly').objectStore(store).getAll()
          rq.onsuccess = (): void => resolve((rq.result as T[]) || [])
          rq.onerror = (): void => resolve([])
        } catch {
          resolve([])
        }
      })
    const projects = await read<PRow>(P_STORE)
    const folders = await read<FRow>(F_STORE)
    try {
      legacy.close()
    } catch {
      /* already closed */
    }

    if (projects.length || folders.length) {
      const mine = await openNamed(dbNameFor(uid))
      if (mine) {
        await new Promise<void>((resolve) => {
          try {
            const tx = mine.transaction([P_STORE, F_STORE], 'readwrite')
            for (const r of projects) tx.objectStore(P_STORE).put(r)
            for (const f of folders) tx.objectStore(F_STORE).put(f)
            tx.oncomplete = (): void => resolve()
            tx.onerror = (): void => resolve()
            tx.onabort = (): void => resolve()
          } catch {
            resolve()
          }
        })
        try {
          mine.close()
        } catch {
          /* already closed */
        }
      }
    }

    // Gone for good — no other account can inherit them.
    try {
      indexedDB.deleteDatabase(DB_NAME)
    } catch {
      /* best effort */
    }
    localStorage.setItem(ADOPT_FLAG, '1')
  } catch {
    /* adoption is best-effort; a failure must never block opening the library */
  }
}

// ---- one-time claim of the old server-side library ------------------------
//
// PER ACCOUNT, not per device. The server query is RLS-scoped to whoever is
// signed in, so each user has their own rows to claim; a device-wide flag meant
// the first account to run it locked everyone else out of their own history.
const claimedUids = new Set<string>()
async function claimServerProjectsOnce(): Promise<void> {
  const uid = await currentUid()
  if (!uid) return // signed out: nothing of anyone's to claim
  if (claimedUids.has(uid)) return
  const flag = `${CLAIM_FLAG}:${uid}`
  try {
    if (localStorage.getItem(flag) === '1') {
      claimedUids.add(uid)
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
      localStorage.setItem(flag, '1')
    } catch {
      /* ignore */
    }
    claimedUids.add(uid)
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
