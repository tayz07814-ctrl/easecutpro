// Browser implementation of the same surface the Electron preload exposed as
// `window.api`. Quick operations are plain HTTP; the long ones (transcribe,
// export) use a job model: POST returns a jobId and the result/progress arrive
// over a WebSocket, so they survive proxy/tunnel request timeouts.
import type { Project, ProjectMeta, ProjectRec } from '@shared/types'
import {
  registerLocalFile,
  isWebMediaId,
  hasLocalFile,
  localProbe,
  localWaveform,
  localThumbnails,
  ensureUploaded,
  ensureAudioUploaded,
  hydrateLocalMedia,
  serverPathOf,
  requestPersistentStorage
} from './webmedia'

// ---- WebSocket (progress + job results) ----
let ws: WebSocket | null = null
let wsReady: Promise<void> | null = null
const progressListeners = new Set<(e: unknown) => void>()
const jobWaiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()

function connectWs(): Promise<void> {
  if (wsReady) return wsReady
  wsReady = new Promise<void>((resolve) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const sock = new WebSocket(`${proto}://${location.host}/ws`)
    ws = sock
    sock.onopen = () => resolve()
    // A blocked/failed WS must never wedge job starts — jobs poll for their
    // result over HTTP anyway; the socket only adds live progress.
    sock.onerror = () => resolve()
    sock.onmessage = (ev) => {
      let msg: any
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'progress') {
        for (const cb of progressListeners)
          cb({ jobId: msg.jobId, kind: msg.kind, percent: msg.percent, message: msg.message })
      } else if (msg.type === 'result') {
        jobWaiters.get(msg.jobId)?.resolve(msg.data)
        jobWaiters.delete(msg.jobId)
      } else if (msg.type === 'error') {
        jobWaiters.get(msg.jobId)?.reject(new Error(msg.message))
        jobWaiters.delete(msg.jobId)
      }
    }
    sock.onclose = () => {
      ws = null
      wsReady = null
      // Reconnect if anything still cares about progress/jobs.
      if (progressListeners.size || jobWaiters.size) setTimeout(() => void connectWs(), 1500)
    }
  })
  return wsReady
}

// ---- HTTP helpers ----
async function call(pathname: string, body?: unknown): Promise<any> {
  const res = await fetch(pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include'
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({}))
    throw new Error(e.error || `HTTP ${res.status}`)
  }
  return res.json()
}

async function runJob(start: () => Promise<{ jobId: string }>): Promise<any> {
  await connectWs()
  const { jobId } = await start()
  return new Promise((resolve, reject) => {
    jobWaiters.set(jobId, { resolve, reject })
    // Polling safety net: the WS routinely drops on tunnels and locked phones,
    // and a result sent while it's down used to be lost forever (UI stuck
    // busy). The job keeps running on the PC, so ask for the outcome over
    // plain HTTP until it lands — whichever channel answers first wins.
    const timer = setInterval(async () => {
      if (!jobWaiters.has(jobId)) {
        clearInterval(timer)
        return
      }
      void connectWs() // nudge the socket back up for live progress
      try {
        const r = await call(`/api/job-result?id=${encodeURIComponent(jobId)}`)
        if (r.pending) return
        const w = jobWaiters.get(jobId)
        jobWaiters.delete(jobId)
        clearInterval(timer)
        if (!w) return
        if (r.msg?.type === 'result') w.resolve(r.msg.data)
        else w.reject(new Error(r.msg?.message || 'job failed'))
      } catch {
        /* offline / old server — try again next tick */
      }
    }, 4000)
  })
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}

function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = true
    input.onchange = () => resolve(input.files ? Array.from(input.files) : [])
    input.click()
  })
}

function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    ;(input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
    input.onchange = () => resolve(input.files ? Array.from(input.files) : [])
    input.click()
  })
}

/** Feed a synthetic progress event to listeners (e.g. client-side uploads). */
function emitProgress(percent: number, message: string, kind = 'export'): void {
  for (const cb of progressListeners) cb({ jobId: 'upload', kind, percent, message })
}

/** Every webmedia: id referenced ANYWHERE in a value (deep walk). Field-by-field
 *  scanning kept missing newer homes for source paths — the doc-native
 *  `project.timeline` clips were saved with browser-only webmedia: ids, which are
 *  dead on reload → the classic BLACK PREVIEW after reopening a project. */
function collectWebMediaIds(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') {
    if (isWebMediaId(node)) out.add(node)
    return
  }
  if (Array.isArray(node)) {
    for (const v of node) collectWebMediaIds(v, out)
    return
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectWebMediaIds(v, out)
  }
}

/** Deep-clone `node` with every mapped webmedia: id swapped for its server path. */
function replaceWebMediaIds<T>(node: T, map: Record<string, string>): T {
  if (typeof node === 'string') return ((map[node] as unknown) ?? node) as T
  if (Array.isArray(node)) return node.map((v) => replaceWebMediaIds(v, map)) as unknown as T
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) out[k] = replaceWebMediaIds(v, map)
    return out as T
  }
  return node
}

/** Upload every local file a project references; return a copy with server paths.
 *  Generic on purpose: any string field anywhere in the project (timeline clips,
 *  legacy tracks, baseSequence, media, music, overlays, future fields) is covered. */
async function uploadProjectMedia(
  project: Project,
  onProgress?: (pct: number) => void
): Promise<Project> {
  const ids = new Set<string>()
  collectWebMediaIds(project, ids)
  // Ids whose File is gone (project loaded from an earlier session) can't be
  // uploaded — skip them so ONE dead reference can't fail the whole save.
  const list = [...ids].filter((id) => hasLocalFile(id))
  if (!list.length) return project
  const map: Record<string, string> = {}
  for (let i = 0; i < list.length; i++) {
    map[list[i]] = await ensureUploaded(list[i], (p) =>
      onProgress?.(Math.round(((i + p / 100) / list.length) * 100))
    )
  }
  return replaceWebMediaIds(project, map)
}

function triggerDownload(url: string, name: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const webApi: Window['api'] = {
  toolStatus: () => call('/api/toolStatus'),
  // Local-first: keep the file in the browser; no upload until the PC needs it.
  openMediaDialog: async () => {
    const f = await pickFile('video/*,audio/*,image/*')
    return f ? registerLocalFile(f) : null
  },
  openMediaDialogMulti: async () => {
    const files = await pickFiles('video/*,audio/*,image/*')
    return files.map((f) => ({ path: registerLocalFile(f), name: f.name }))
  },
  importFolder: async () => {
    const MEDIA_RE = /\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|aac|png|jpe?g|webp|gif|bmp)$/i
    const files = (await pickFolder()).filter((f) => MEDIA_RE.test(f.name))
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    return files.map((f) => ({ path: registerLocalFile(f), name: f.name }))
  },
  combineClips: async (clips, audioOnly) => {
    // Upload any browser-local clips to the PC first, then combine there.
    const uploaded = await Promise.all(
      clips.map(async (c) =>
        isWebMediaId(c.sourcePath)
          ? { ...c, sourcePath: await ensureUploaded(c.sourcePath, (p) => emitProgress(p, 'Cut Lord is working…', 'export')) }
          : c
      )
    )
    return runJob(() => call('/api/combine', { clips: uploaded, audioOnly: !!audioOnly }))
  },
  probe: (path) => (isWebMediaId(path) ? localProbe(path) : call('/api/probe', { path })),
  waveform: (path) => (isWebMediaId(path) ? localWaveform(path) : call('/api/waveform', { path })),
  // Desktop-only (native ffmpeg preview audio); web preview decodes in-browser.
  previewAudioWav: async () => {
    throw new Error('previewAudioWav is desktop-only')
  },
  sttAudioWav: async () => {
    throw new Error('sttAudioWav is desktop-only')
  },
  // Proxy rendering needs local ffmpeg; the browser keeps the live engine.
  buildPreviewProxy: async () => '',
  buildPreviewProxyManual: async () => '', // web: no local ffmpeg
  existingPreviewProxy: async () => '',
  conditionPreviewMedia: async () => '', // web: no local ffmpeg to condition with
  // No file manager in a browser — the download already went to the user.
  revealPath: async () => undefined,
  thumbnails: (path, intervalSec, onPartial) =>
    isWebMediaId(path) ? localThumbnails(path, intervalSec, onPartial) : call('/api/thumbnails', { path, intervalSec }),
  transcribe: async (path, backend, modelName) => {
    // Only the AUDIO is needed — extract it in the browser and upload just that
    // (~15x smaller than the video) instead of the whole file.
    const sp = isWebMediaId(path)
      ? await ensureAudioUploaded(path, (p) => emitProgress(p, 'Cut Lord is working…', 'transcribe'))
      : path
    return runJob(() => call('/api/transcribe', { path: sp, backend, modelName }))
  },
  suggestCuts: (transcript) => runJob(() => call('/api/suggest-cuts', { transcript })),
  fastCut: async (transcript, audioPath, script) => {
    // Upload just the audio (small) so the PC-side engine can run the acoustic tier.
    const sp = audioPath
      ? isWebMediaId(audioPath)
        ? await ensureAudioUploaded(audioPath, (p) => emitProgress(p, 'Fast Cut is working…', 'transcribe'))
        : audioPath
      : undefined
    return runJob(() => call('/api/fast-cut', { transcript, path: sp, script }))
  },
  cutCutPro: async (path, transcript, modelName, script) => {
    // Only audio is needed on the PC — upload the small extracted track.
    const sp = isWebMediaId(path)
      ? await ensureAudioUploaded(path, (p) => emitProgress(p, 'Cut Lord is working…', 'transcribe'))
      : path
    return runJob(() => call('/api/cutcutpro', { path: sp, transcript, modelName, script }))
  },
  retakeAwareCut: async (path) => {
    // Retake-Aware Cut Beta: separate job/mode; audio-only upload like ProCut.
    const sp = isWebMediaId(path)
      ? await ensureAudioUploaded(path, (p) => emitProgress(p, 'Retake β is working…', 'transcribe'))
      : path
    return runJob(() => call('/api/retake-cut', { path: sp, cut_mode: 'retake_aware_beta' }))
  },
  generateOverlays: (transcript, assets, rules, opts) =>
    runJob(() => call('/api/generate-overlays', { transcript, assets, rules, opts })),
  suggestOverlays: (transcript, assets, opts) =>
    runJob(() => call('/api/suggest-overlays', { transcript, assets, opts })),
  describeOverlayImage: (imageBase64, mediaType) =>
    call('/api/describe-overlay', { imageBase64, mediaType }),
  matchMoment: (frames, line, overlays) =>
    call('/api/match-moment', { frames, line, overlays }),
  openaiStatus: () => call('/api/openai-status'),
  whisperModels: async () => (await call('/api/whisper-models')).models,
  exportProject: async (project, settings, textOverlays) => {
    const proj = await uploadProjectMedia(project, (p) => emitProgress(p, 'Uploading to server — compiling your clips…', 'export'))
    const out = await runJob(() => call('/api/export', { project: proj, settings, textOverlays }))
    triggerDownload(out.downloadUrl, out.name)
    return out.name
  },
  saveProject: async (project) => {
    const name = `${(project.name || 'project').replace(/\.[^.]+$/, '')}.ecp.json`
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    triggerDownload(url, name)
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    return name
  },
  loadProject: async () => {
    const f = await pickFile('.json,application/json')
    if (!f) return null
    try {
      return JSON.parse(await f.text()) as Project
    } catch {
      return null
    }
  },
  onProgress: (cb) => {
    progressListeners.add(cb as (e: unknown) => void)
    void connectWs()
    return () => progressListeners.delete(cb as (e: unknown) => void)
  },
  // Project library (backed by the per-user server store)
  listProjects: () => httpListProjects(),
  createProject: (name, project) => httpCreateProject(name, project),
  getProject: (id) => httpGetProject(id),
  saveProjectRecord: (id, patch) => httpSaveProject(id, patch),
  deleteProjectRecord: (id) => httpDeleteProject(id)
}

export function installWebApi(): void {
  window.api = webApi
  // Media autosaves to THIS device (IndexedDB) — ask the browser to keep it.
  requestPersistentStorage()
}

// ---- Accounts ----
export interface AuthUser {
  id: string
  email: string
}
async function authPost(pathname: string, body: unknown): Promise<any> {
  const r = await fetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include'
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}
export async function authMe(): Promise<{ user: AuthUser | null; signupGated: boolean }> {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' })
    const d = await r.json().catch(() => ({}))
    return { user: r.ok ? d.user : null, signupGated: !!d.signupGated }
  } catch {
    return { user: null, signupGated: false }
  }
}
export async function authSignup(email: string, password: string, code: string): Promise<AuthUser> {
  return (await authPost('/api/auth/signup', { email, password, code })).user
}
export async function authLogin(email: string, password: string): Promise<AuthUser> {
  return (await authPost('/api/auth/login', { email, password })).user
}
export async function authLogout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
  } catch {
    /* ignore */
  }
}

// ---- Projects (HTTP — these back window.api's project methods on the web) ----
async function httpListProjects(): Promise<ProjectMeta[]> {
  const r = await fetch('/api/projects', { credentials: 'include' })
  if (!r.ok) return []
  return (await r.json()).projects as ProjectMeta[]
}
function httpCreateProject(name: string, project: Project | null): Promise<{ id: string; name: string }> {
  return authPost('/api/projects', { name, project })
}
async function httpGetProject(id: string): Promise<ProjectRec | null> {
  const r = await fetch(`/api/projects/${id}`, { credentials: 'include' })
  if (!r.ok) return null
  return r.json()
}
async function httpSaveProject(
  id: string,
  patch: { name?: string; project?: Project; thumb?: string }
): Promise<void> {
  await fetch(`/api/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    credentials: 'include'
  })
}
async function httpDeleteProject(id: string): Promise<void> {
  await fetch(`/api/projects/${id}`, { method: 'DELETE', credentials: 'include' })
}

/** Upload any browser-local media a project references; returns a server-path copy. */
export async function uploadAndServerize(project: Project): Promise<Project> {
  return uploadProjectMedia(project)
}

/** ZERO-network serialize for autosave: swap only the webmedia ids that are
 *  ALREADY on the PC (an engine/export/save uploaded them earlier) for their
 *  server paths. Records converge to PC paths over time without autosave ever
 *  uploading a video itself. */
export function serializeKnownUploads(project: Project): Project {
  const ids = new Set<string>()
  collectWebMediaIds(project, ids)
  const map: Record<string, string> = {}
  for (const id of ids) {
    const sp = serverPathOf(id)
    if (sp) map[id] = sp
  }
  return Object.keys(map).length ? replaceWebMediaIds(project, map) : project
}

/** Restore this device's local media (IndexedDB) for every webmedia id the
 *  project references, so a reopened project plays without any upload. */
export async function hydrateProjectMedia(project: Project): Promise<void> {
  const ids = new Set<string>()
  collectWebMediaIds(project, ids)
  if (ids.size) await hydrateLocalMedia([...ids])
}
