// Cloud Cowork — client data + storage layer.
//
// Spaces / members / projects live in Supabase (RLS-enforced); the actual files
// (per-member project-edit JSON + raw media) live in Cloudflare R2, reached only
// through presigned URLs minted by the `r2-sign` edge function (R2 creds stay
// server-side). Media keeps its CANONICAL webmedia id as its R2 key, and on open
// each downloaded file is re-registered under that same id — so a shared project's
// media refs resolve on every member's device with no remapping.

import type { Project } from '@shared/types'
import { getSupabase, invokeEdge } from './supabase'
import { serializeProjectLite } from '../projectsApi'
import { registerLocalFileAs, getFile, hasLocalFile, isWebMediaId } from '../webmedia'

export const GiB = 1073741824

export interface Space {
  id: string
  name: string
  owner_id: string
  quota_bytes: number
  is_paid: boolean
  join_key: string
}
export interface Member {
  user_id: string
  role: string
  username: string
  email: string
  name: string
}
export interface Notif {
  id: string
  kind: string
  space_id: string | null
  space_name: string | null
  join_key: string | null
  from_name: string | null
  message: string | null
  read: boolean
  created_at: string
}
export interface CoworkProject {
  id: string
  space_id: string
  name: string
  media_bytes: number
  updated_at: string
  folder_id?: string | null
}
/** A folder inside a space (shared across all members). */
export interface SpaceFolder {
  id: string
  name: string
}
export interface EditVersion {
  user_id: string
  member_name: string
  updated_at: string
  bytes: number
}
/** A pending request to join a space (self-service, awaiting owner approval). */
export interface JoinRequest {
  id: string
  user_id: string
  username: string
  email: string
  name: string
  created_at: string
}
/** Per-file transfer reporter. The UI (store) implements this so the dashboard
 *  dock can show a live progress bar per uploaded/downloaded file. */
export interface XferHandle {
  progress(loaded: number, total: number): void
  done(error?: string): void
}
export interface XferReporter {
  start(name: string, kind: 'upload' | 'download'): XferHandle
}
// `size` lets download progress compute a real % even when R2's cross-origin
// response doesn't expose Content-Length to the XHR progress event.
type MediaManifest = Record<string, { name: string; type: string; size?: number }>

// ---- helpers ------------------------------------------------------------

/** Walk a value and collect every `webmedia:` id it references. */
function collectMediaIds(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') {
    if (isWebMediaId(node)) out.add(node)
    return
  }
  if (Array.isArray(node)) {
    for (const v of node) collectMediaIds(v, out)
    return
  }
  if (node && typeof node === 'object') for (const v of Object.values(node)) collectMediaIds(v, out)
}

const mediaKey = (pid: string, id: string): string => `projects/${pid}/media/${id.replace('webmedia:', '')}`
const manifestKey = (pid: string): string => `projects/${pid}/media/_manifest.json`
const editKey = (pid: string, uid: string): string => `projects/${pid}/edits/${uid}.json`

async function presign(
  op: 'put' | 'get',
  spaceId: string,
  key: string,
  opts?: { contentLength?: number; countsToQuota?: boolean }
): Promise<string> {
  const r = await invokeEdge<{ url: string; key: string }>('r2-sign', { op, spaceId, key, ...opts })
  return r.url
}
/** PUT via XHR so we get real upload-progress events (fetch exposes none). */
function xhrPut(url: string, blob: Blob, onProgress?: (loaded: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    if (onProgress) xhr.upload.onprogress = (e): void => { if (e.lengthComputable) onProgress(e.loaded, e.total) }
    xhr.onload = (): void =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`))
    xhr.onerror = (): void => reject(new Error('Upload failed — network error'))
    xhr.ontimeout = (): void => reject(new Error('Upload timed out'))
    xhr.send(blob)
  })
}
/** GET a Blob via XHR with progress. `knownTotal` (from the manifest) keeps the
 *  percentage accurate when R2's cross-origin response hides Content-Length from
 *  the progress event (only `loaded` is reliably available cross-origin). */
function xhrGetBlob(url: string, onProgress?: (loaded: number, total: number) => void, knownTotal = 0): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'blob'
    if (onProgress) xhr.onprogress = (e): void => onProgress(e.loaded, knownTotal || (e.lengthComputable ? e.total : 0))
    xhr.onload = (): void =>
      xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response as Blob) : reject(new Error(`Download failed (${xhr.status})`))
    xhr.onerror = (): void => reject(new Error('Download failed — network error'))
    xhr.send()
  })
}
async function r2Put(
  spaceId: string,
  key: string,
  blob: Blob,
  countsToQuota: boolean,
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  const url = await presign('put', spaceId, key, { contentLength: blob.size, countsToQuota })
  await xhrPut(url, blob, onProgress)
}
async function r2GetBlob(
  spaceId: string,
  key: string,
  onProgress?: (loaded: number, total: number) => void,
  knownTotal = 0
): Promise<Blob> {
  const url = await presign('get', spaceId, key)
  return xhrGetBlob(url, onProgress, knownTotal)
}
async function r2GetJson<T>(spaceId: string, key: string): Promise<T> {
  const res = await fetch(await presign('get', spaceId, key))
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  return (await res.json()) as T
}

/** The signed-in user's id, email, display name and username. */
export async function me(): Promise<{ id: string; email: string; name: string; username: string }> {
  const sb = getSupabase()
  const { data } = await sb.auth.getUser()
  const u = data.user
  const email = u?.email ?? ''
  let name = email.split('@')[0] || 'Me'
  let username = ''
  if (u) {
    try {
      const { data: p } = await sb.from('profiles').select('display_name,username').eq('id', u.id).maybeSingle()
      if (p?.username) username = p.username as string
      if (p?.display_name) name = p.display_name as string
      else if (username) name = username
    } catch {
      /* fall back to the email local part */
    }
  }
  return { id: u?.id ?? '', email, name, username }
}

/** Change the signed-in user's username (unique, case-insensitive). */
export async function setUsername(username: string): Promise<void> {
  const sb = getSupabase()
  const u = (await sb.auth.getUser()).data.user
  if (!u) throw new Error('Not signed in')
  const clean = username.trim().replace(/^@/, '')
  if (!/^[a-zA-Z0-9_.]{3,24}$/.test(clean)) {
    throw new Error('Usernames are 3–24 chars: letters, numbers, _ or .')
  }
  const { error } = await sb.from('profiles').update({ username: clean }).eq('id', u.id)
  if (error) {
    if (/duplicate|unique/i.test(error.message)) throw new Error('That username is taken')
    throw new Error(error.message)
  }
}

// ---- spaces -------------------------------------------------------------

export async function listSpaces(): Promise<Space[]> {
  const { data, error } = await getSupabase()
    .from('spaces')
    .select('id,name,owner_id,quota_bytes,is_paid,join_key')
    .order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as Space[]
}
export async function createSpace(name: string): Promise<Space> {
  const { data, error } = await getSupabase()
    .from('spaces')
    .insert({ name: name.trim() || 'Untitled space' })
    .select('id,name,owner_id,quota_bytes,is_paid,join_key')
    .single()
  if (error) throw new Error(error.message)
  return data as Space
}
/** Give a new user their default free space on first visit (client-side so it
 *  only applies to the 0.01 cowork flow, never main's signups). */
export async function ensureDefaultSpace(): Promise<Space[]> {
  const spaces = await listSpaces()
  if (spaces.length) return spaces
  await createSpace('My space')
  return listSpaces()
}
export async function renameSpace(id: string, name: string): Promise<void> {
  const { error } = await getSupabase().from('spaces').update({ name: name.trim() }).eq('id', id)
  if (error) throw new Error(error.message)
}
export async function deleteSpace(id: string): Promise<void> {
  const { error } = await getSupabase().from('spaces').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ---- members ------------------------------------------------------------

export async function listMembers(spaceId: string): Promise<Member[]> {
  // cowork_members is SECURITY DEFINER: it can read co-members' profiles even
  // though `profiles` itself is read-own-only.
  const { data, error } = await getSupabase().rpc('cowork_members', { p_space: spaceId })
  if (error) throw new Error(error.message)
  return (data ?? []) as Member[]
}
/** Invite by username OR email — drops an in-app notification in their inbox for
 *  them to accept (owner-only). They must already have an EaseCut account. */
export async function inviteMember(spaceId: string, identifier: string): Promise<void> {
  const id = identifier.trim()
  if (!id) throw new Error('Enter a username or email')
  const { data, error } = await getSupabase().rpc('cowork_invite', { p_space: spaceId, p_identifier: id })
  if (error) throw new Error(error.message)
  const status = String(data)
  if (status === 'no_account') throw new Error('No EaseCut account matches that username or email.')
  if (status === 'already_member') throw new Error('They are already in this space.')
  if (status === 'forbidden') throw new Error('Only the space owner can invite members.')
  if (status !== 'ok') throw new Error('Could not send the invite.')
}
/** Owner (or the member themselves) removes a member from a space. */
export async function removeMember(spaceId: string, userId: string): Promise<void> {
  const { error } = await getSupabase().from('space_members').delete().eq('space_id', spaceId).eq('user_id', userId)
  if (error) throw new Error(error.message)
}
/** Ask to join a space by its shareable key. Creates a pending request that the
 *  space owner must approve — nobody joins a space without approval. Returns one
 *  of: 'requested' | 'pending' (already asked) | 'already_member'. */
export async function requestJoinByKey(key: string): Promise<'requested' | 'pending' | 'already_member'> {
  const k = key.trim()
  if (!k) throw new Error('Enter a space key')
  const { data, error } = await getSupabase().rpc('cowork_request_join', { p_key: k })
  if (error) throw new Error(error.message)
  const res = String(data)
  if (res === 'not_found') throw new Error('No space matches that key.')
  return res as 'requested' | 'pending' | 'already_member'
}

/** Owner: list people waiting for approval to join a space. */
export async function listJoinRequests(spaceId: string): Promise<JoinRequest[]> {
  const { data, error } = await getSupabase().rpc('cowork_list_requests', { p_space: spaceId })
  if (error) throw new Error(error.message)
  return (data ?? []) as JoinRequest[]
}
/** Owner: approve (adds the member) or reject a pending join request. */
export async function decideJoinRequest(requestId: string, approve: boolean): Promise<void> {
  const { data, error } = await getSupabase().rpc('cowork_decide_request', { p_request: requestId, p_approve: approve })
  if (error) throw new Error(error.message)
  if (String(data) === 'forbidden') throw new Error('Only the space owner can do that.')
}
/** Owner: mint a fresh random join key (invalidates the old one). Returns it. */
export async function regenerateJoinKey(spaceId: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('cowork_regen_key', { p_space: spaceId })
  if (error) throw new Error(error.message)
  const key = String(data)
  if (key === 'forbidden') throw new Error('Only the space owner can regenerate the key.')
  return key
}

// ---- notifications ------------------------------------------------------

export async function listNotifications(): Promise<Notif[]> {
  const { data, error } = await getSupabase()
    .from('notifications')
    .select('id,kind,space_id,space_name,join_key,from_name,message,read,created_at')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw new Error(error.message)
  return (data ?? []) as Notif[]
}
export async function markNotifRead(id: string): Promise<void> {
  await getSupabase().from('notifications').update({ read: true }).eq('id', id)
}
export async function markAllNotifsRead(): Promise<void> {
  await getSupabase().from('notifications').update({ read: true }).eq('read', false)
}
export async function deleteNotif(id: string): Promise<void> {
  await getSupabase().from('notifications').delete().eq('id', id)
}
/** Accept an owner-initiated invite. The owner invited this user directly, so no
 *  approval step is needed — the edge RPC verifies the invite notification exists
 *  before adding them (a leaked key alone can't be used to self-join anymore). */
export async function acceptInvite(n: Notif): Promise<string> {
  if (!n.space_id) throw new Error('This invite is missing its space.')
  const { data, error } = await getSupabase().rpc('cowork_accept_invite', { p_space: n.space_id })
  if (error) throw new Error(error.message)
  const res = String(data)
  if (res === 'no_invite') throw new Error('This invite is no longer valid.')
  await markNotifRead(n.id)
  return res
}

// ---- projects -----------------------------------------------------------

export async function listSpaceProjects(spaceId: string): Promise<CoworkProject[]> {
  const { data, error } = await getSupabase()
    .from('space_projects')
    .select('id,space_id,name,media_bytes,updated_at,folder_id')
    .eq('space_id', spaceId)
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as CoworkProject[]
}

// ---- folders ------------------------------------------------------------

export async function listSpaceFolders(spaceId: string): Promise<SpaceFolder[]> {
  const { data, error } = await getSupabase()
    .from('space_folders')
    .select('id,name')
    .eq('space_id', spaceId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as SpaceFolder[]
}
export async function createSpaceFolder(spaceId: string, name: string): Promise<SpaceFolder> {
  const { data, error } = await getSupabase()
    .from('space_folders')
    .insert({ space_id: spaceId, name: name.trim() || 'New folder' })
    .select('id,name')
    .single()
  if (error) throw new Error(error.message)
  return data as SpaceFolder
}
export async function renameSpaceFolder(id: string, name: string): Promise<void> {
  const { error } = await getSupabase().from('space_folders').update({ name: name.trim() }).eq('id', id)
  if (error) throw new Error(error.message)
}
/** Delete a folder; its projects fall back to unfiled (FK on delete set null). */
export async function deleteSpaceFolder(id: string): Promise<void> {
  const { error } = await getSupabase().from('space_folders').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
export async function moveSpaceProjectToFolder(projectId: string, folderId: string | null): Promise<void> {
  const { data, error } = await getSupabase().rpc('cowork_move_project', { p_project: projectId, p_folder: folderId })
  if (error) throw new Error(error.message)
  if (String(data) === 'forbidden') throw new Error('Only space members can move projects.')
}
export async function spaceUsage(spaceId: string): Promise<{ used: number; quota: number }> {
  const sb = getSupabase()
  const [{ data: sp }, { data: projs }] = await Promise.all([
    sb.from('spaces').select('quota_bytes').eq('id', spaceId).maybeSingle(),
    sb.from('space_projects').select('media_bytes').eq('space_id', spaceId)
  ])
  const quota = Number((sp as { quota_bytes: number } | null)?.quota_bytes ?? 100 * GiB)
  const used = (projs ?? []).reduce((n: number, r) => n + Number((r as { media_bytes: number }).media_bytes || 0), 0)
  return { used, quota }
}
export async function listEditVersions(projectId: string): Promise<EditVersion[]> {
  const { data, error } = await getSupabase()
    .from('space_project_edits')
    .select('user_id,member_name,updated_at,bytes')
    .eq('project_id', projectId)
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as EditVersion[]
}

/** Push the current editor project into a space: upload every in-session media
 *  file + this user's edit JSON to R2, and create the project + edit rows. */
export async function shareProject(
  spaceId: string,
  project: Project,
  name: string,
  xfer?: XferReporter,
  folderId?: string | null
): Promise<CoworkProject> {
  const sb = getSupabase()
  const u = await me()
  const { data: rec, error } = await sb
    .from('space_projects')
    .insert({ space_id: spaceId, name: name.trim() || 'Untitled', created_by: u.id, folder_id: folderId ?? null })
    .select('id,space_id,name,media_bytes,updated_at,folder_id')
    .single()
  if (error) throw new Error(error.message)
  const pid = (rec as CoworkProject).id

  const ids = new Set<string>()
  collectMediaIds(project, ids)
  // Only files whose bytes are in THIS browser session can be uploaded.
  const files: { id: string; f: File }[] = []
  for (const id of ids) {
    const f = getFile(id)
    if (f) files.push({ id, f })
  }

  // One dock row per media file, each with a live byte-progress bar.
  const manifest: MediaManifest = {}
  let total = 0
  for (const { id, f } of files) {
    const h = xfer?.start(f.name, 'upload')
    try {
      await r2Put(spaceId, mediaKey(pid, id), f, true, (l, t) => h?.progress(l, t))
      h?.done()
    } catch (e) {
      h?.done(e instanceof Error ? e.message : 'Upload failed')
      throw e
    }
    manifest[id] = { name: f.name, type: f.type, size: f.size }
    total += f.size
  }

  // Manifest + this member's edit JSON are tiny — one combined "Project data" row.
  const h = xfer?.start('Project data', 'upload')
  const editBlob = new Blob([JSON.stringify(serializeProjectLite(project))], { type: 'application/json' })
  try {
    await r2Put(spaceId, manifestKey(pid), new Blob([JSON.stringify(manifest)], { type: 'application/json' }), false)
    await r2Put(spaceId, editKey(pid, u.id), editBlob, false, (l, t) => h?.progress(l, t))
    h?.done()
  } catch (e) {
    h?.done(e instanceof Error ? e.message : 'Upload failed')
    throw e
  }

  const now = new Date().toISOString()
  await sb.from('space_projects').update({ media_bytes: total, updated_at: now }).eq('id', pid)
  await sb
    .from('space_project_edits')
    .upsert({ project_id: pid, user_id: u.id, member_name: u.name, bytes: editBlob.size, updated_at: now }, { onConflict: 'project_id,user_id' })
  return { ...(rec as CoworkProject), media_bytes: total }
}

/** Load a space project (a chosen member's edit, or the most recent) into a
 *  Project: download the edit JSON + its media from R2, registering each file
 *  under its canonical id so the editor plays it locally. */
export async function openSpaceProject(
  cp: CoworkProject,
  editUserId: string | null,
  onStep?: (s: string) => void,
  xfer?: XferReporter
): Promise<Project> {
  const { space_id: spaceId, id: pid } = cp
  let uid = editUserId
  if (!uid) {
    const versions = await listEditVersions(pid)
    uid = versions[0]?.user_id ?? (await me()).id
  }
  onStep?.('Loading project…')
  const project = await r2GetJson<Project>(spaceId, editKey(pid, uid))

  let manifest: MediaManifest = {}
  try {
    manifest = await r2GetJson<MediaManifest>(spaceId, manifestKey(pid))
  } catch {
    /* older share without a manifest — fall back to generic names */
  }
  const ids = new Set<string>()
  collectMediaIds(project, ids)
  for (const id of ids) {
    if (hasLocalFile(id)) continue
    const meta = manifest[id]
    const name = meta?.name || `${id.replace('webmedia:', '')}.mp4`
    onStep?.('Downloading media…')
    const h = xfer?.start(name, 'download')
    try {
      const blob = await r2GetBlob(spaceId, mediaKey(pid, id), (l, t) => h?.progress(l, t), meta?.size || 0)
      registerLocalFileAs(id, new File([blob], name, { type: meta?.type || blob.type || 'video/mp4' }))
      h?.done()
    } catch {
      /* a missing media file just shows as a missing clip; the rest still opens */
      h?.done('Download failed')
    }
  }
  return project
}

/** Save the current project back as THIS member's edit version. Also uploads any
 *  media this member added since the project's last manifest, so the other members
 *  can play the new clips (the edit JSON alone would reference bytes only this
 *  browser has). */
export async function saveMyEdit(cp: CoworkProject, project: Project): Promise<void> {
  const sb = getSupabase()
  const u = await me()

  // Media diff: upload any referenced file that isn't already in R2's manifest.
  try {
    let manifest: MediaManifest = {}
    try {
      manifest = await r2GetJson<MediaManifest>(cp.space_id, manifestKey(cp.id))
    } catch {
      /* no manifest yet — treat everything as new */
    }
    const ids = new Set<string>()
    collectMediaIds(project, ids)
    let addedBytes = 0
    let changed = false
    for (const id of ids) {
      if (manifest[id]) continue
      const f = getFile(id)
      if (!f) continue // bytes not in this session — can't upload
      await r2Put(cp.space_id, mediaKey(cp.id, id), f, true)
      manifest[id] = { name: f.name, type: f.type, size: f.size }
      addedBytes += f.size
      changed = true
    }
    if (changed) {
      await r2Put(cp.space_id, manifestKey(cp.id), new Blob([JSON.stringify(manifest)], { type: 'application/json' }), false)
      const { data } = await sb.from('space_projects').select('media_bytes').eq('id', cp.id).maybeSingle()
      await sb
        .from('space_projects')
        .update({ media_bytes: Number((data as { media_bytes: number } | null)?.media_bytes ?? 0) + addedBytes })
        .eq('id', cp.id)
    }
  } catch {
    /* media sync is best-effort — the edit JSON below is the source of truth */
  }

  const editBlob = new Blob([JSON.stringify(serializeProjectLite(project))], { type: 'application/json' })
  await r2Put(cp.space_id, editKey(cp.id, u.id), editBlob, false)
  const now = new Date().toISOString()
  await sb
    .from('space_project_edits')
    .upsert({ project_id: cp.id, user_id: u.id, member_name: u.name, bytes: editBlob.size, updated_at: now }, { onConflict: 'project_id,user_id' })
  await sb.from('space_projects').update({ updated_at: now }).eq('id', cp.id)
}

/** Human "12.4 GB of 100 GB" string. */
export function fmtBytes(n: number): string {
  if (n >= GiB) return `${(n / GiB).toFixed(n >= 10 * GiB ? 0 : 1)} GB`
  if (n >= 1048576) return `${Math.round(n / 1048576)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}
