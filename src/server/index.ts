/**
 * EaseCutPro web server — turns your PC into the "cloud" backend.
 *
 * Serves the built web client and exposes the editor's heavy operations (probe,
 * transcribe, silence, waveform, thumbnails, export) over HTTP + a WebSocket for
 * progress, reusing src/main/ffmpeg.ts + whisper.ts.
 *
 * Accounts: email + password (hashed with scrypt) stored on the PC. Each user
 * gets an isolated folder (uploads/exports/projects) and a signed session cookie.
 * Projects (the full edit) are saved per user — a CapCut-style library.
 *
 * Security: signup can be gated with EC_SIGNUP_CODE (set by `npm run remote`).
 * Every path that reaches ffmpeg/whisper or the media streamer is validated to
 * live inside the requesting user's folder (or EC_BROWSE_ROOTS).
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID, randomBytes, scryptSync, createHmac, timingSafeEqual } from 'crypto'
import express, { type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import { WebSocketServer, WebSocket } from 'ws'

import { checkTools, listWhisperModels } from '../main/binaries'
import { probe, extractWaveform, extractThumbnails, detectSilence, exportProject, combineClips, extractAudioM4a } from '../main/ffmpeg'
import { transcribe } from '../main/whisper'
import { transcribeOpenAI } from '../main/openai-transcribe'
import { transcribeParakeet } from '../main/parakeet'
import { suggestCutsAI } from '../main/ai-cut'
import { judgeCuts } from '../main/ai-cut-judge'
import { cutCutPro } from '../main/cutcutpro'
import { retakeAwareCut } from '../main/retakeaware/engine'
import { fastCutSuggest, startFastcutSidecar, stopFastcutSidecar } from '../main/fast-cut'
import { generateOverlayTimeline } from '../main/overlay-rules'
import { openaiAvailable } from '../main/openai'
import type { Project, Transcript, TranscribeBackend, OverlayAsset, OverlayRule } from '../shared/types'

// ---- Config ----
const PORT = Number(process.env.EC_PORT || process.env.PORT || 8787)
const HOST = process.env.EC_HOST || '0.0.0.0'
const SIGNUP_CODE = process.env.EC_SIGNUP_CODE || '' // empty = open signup (localhost only!)
const SECURE_COOKIES = process.env.EC_SECURE_COOKIES === '1' // append "; Secure" when served over HTTPS (tunnel/domain)
const WORK = path.resolve(process.env.EC_WORK_DIR || path.join(process.cwd(), '.ecweb'))
const BROWSE_ROOTS = (process.env.EC_BROWSE_ROOTS || '')
  .split(path.delimiter)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p))
const RENDERER_DIR = path.resolve(process.cwd(), 'out', 'renderer')

fs.mkdirSync(path.join(WORK, 'users'), { recursive: true })

process.on('uncaughtException', (e) => console.error('[server] uncaughtException:', (e as Error)?.message ?? e))
process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection:', (e as Error)?.message ?? e))

// ---- Server secret (signs session cookies) ----
const SECRET = (() => {
  const f = path.join(WORK, '.secret')
  try {
    return fs.readFileSync(f, 'utf8').trim()
  } catch {
    const s = randomBytes(32).toString('hex')
    fs.writeFileSync(f, s)
    return s
  }
})()

// ---- Users ----
interface User {
  id: string
  email: string
  salt: string
  hash: string
  createdAt: number
}
const usersFile = path.join(WORK, 'users.json')
const users: Record<string, User> = (() => {
  try {
    return JSON.parse(fs.readFileSync(usersFile, 'utf8'))
  } catch {
    return {}
  }
})()
function saveUsers(): void {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2))
}
function hashPw(pw: string, salt: string): string {
  return scryptSync(pw, salt, 64).toString('hex')
}
function userByEmail(email: string): User | undefined {
  return Object.values(users).find((u) => u.email === email)
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// ---- Sessions (stateless signed cookie: "<userId>.<hmac>") ----
function signSession(userId: string): string {
  const sig = createHmac('sha256', SECRET).update(userId).digest('hex')
  return `${userId}.${sig}`
}
function verifySession(val: string): string | null {
  const i = val.lastIndexOf('.')
  if (i <= 0) return null
  const id = val.slice(0, i)
  const sig = val.slice(i + 1)
  const exp = createHmac('sha256', SECRET).update(id).digest('hex')
  return safeEqual(sig, exp) ? id : null
}
function setSession(res: Response, userId: string): void {
  const secure = SECURE_COOKIES ? '; Secure' : ''
  res.setHeader(
    'Set-Cookie',
    `ec_sess=${signSession(userId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 60}${secure}`
  )
}
function sessionFromReq(req: { headers: http.IncomingHttpHeaders; query?: any }): string {
  const cookie = req.headers.cookie || ''
  const m = cookie.match(/(?:^|;\s*)ec_sess=([^;]+)/)
  if (m) return decodeURIComponent(m[1])
  if (req.query && req.query.t) return String(req.query.t) // for <video>/<img>/ws
  const h = req.headers['authorization']
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7)
  return ''
}
function userIdFromReq(req: { headers: http.IncomingHttpHeaders; query?: any }): string | null {
  const s = sessionFromReq(req)
  if (!s) return null
  const id = verifySession(s)
  return id && users[id] ? id : null
}

interface AuthedRequest extends Request {
  userId: string
}
function requireUser(req: Request, res: Response, next: NextFunction): void {
  const id = userIdFromReq(req)
  if (!id) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  ;(req as AuthedRequest).userId = id
  next()
}

// ---- Per-user storage + path validation ----
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
function userDir(id: string): string {
  return path.join(WORK, 'users', id)
}
function ensureDir(d: string): string {
  fs.mkdirSync(d, { recursive: true })
  return d
}
const userUploads = (id: string): string => ensureDir(path.join(userDir(id), 'uploads'))
const userExports = (id: string): string => ensureDir(path.join(userDir(id), 'exports'))
const userProjectsDir = (id: string): string => ensureDir(path.join(userDir(id), 'projects'))

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
function assertAllowed(userId: string, p: unknown): string {
  if (!p || typeof p !== 'string') throw new Error('Missing path')
  const abs = path.resolve(p)
  const real = realOrSelf(abs)
  const roots = [realOrSelf(userDir(userId)), ...BROWSE_ROOTS.map(realOrSelf)]
  for (const root of roots) if (isWithin(real, root) || isWithin(abs, root)) return abs
  throw new Error(`Path not allowed: ${p}`)
}
function validateProjectPaths(userId: string, project: Project): void {
  if (project.media?.path) assertAllowed(userId, project.media.path)
  for (const t of project.tracks ?? []) for (const c of t.clips ?? []) if (c.sourcePath) assertAllowed(userId, c.sourcePath)
  for (const c of project.baseSequence ?? []) if (c.sourcePath) assertAllowed(userId, c.sourcePath)
  if (project.music?.path) assertAllowed(userId, project.music.path)
}
function safeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9-]/g, '')
}

// ---- App ----
const app = express()
// Behind Cloudflare Tunnel: trust X-Forwarded-* so req.ip is the real client IP
// (used by rate limiting) and req.protocol reflects HTTPS.
app.set('trust proxy', true)
app.use(express.json({ limit: '256mb' }))

// ---- Basic in-memory rate limiting (brute-force guard on the auth endpoints) ----
const rlBuckets = new Map<string, { count: number; resetAt: number }>()
function rateLimit(max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.path}:${req.ip}`
    const now = Date.now()
    let b = rlBuckets.get(key)
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs }
      rlBuckets.set(key, b)
    }
    b.count++
    if (b.count > max) {
      res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' })
      return
    }
    next()
  }
}

// Public auth endpoints (rate-limited per IP to blunt brute force)
app.post('/api/auth/signup', rateLimit(20, 60_000), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const code = String(req.body?.code || '')
  if (SIGNUP_CODE && code !== SIGNUP_CODE) {
    res.status(403).json({ error: 'Invalid signup code' })
    return
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: 'Enter a valid email' })
    return
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' })
    return
  }
  if (userByEmail(email)) {
    res.status(409).json({ error: 'That email is already registered' })
    return
  }
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  users[id] = { id, email, salt, hash: hashPw(password, salt), createdAt: Date.now() }
  saveUsers()
  setSession(res, id)
  res.json({ user: { id, email } })
})

app.post('/api/auth/login', rateLimit(10, 60_000), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const u = userByEmail(email)
  if (!u || !safeEqual(hashPw(password, u.salt), u.hash)) {
    res.status(401).json({ error: 'Wrong email or password' })
    return
  }
  setSession(res, u.id)
  res.json({ user: { id: u.id, email: u.email } })
})

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'ec_sess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
  res.json({ ok: true })
})

app.get('/api/auth/me', (req, res) => {
  const id = userIdFromReq(req)
  if (id) res.json({ user: { id, email: users[id].email }, signupGated: !!SIGNUP_CODE })
  else res.status(401).json({ error: 'not logged in', signupGated: !!SIGNUP_CODE })
})

// Everything else under /api requires a logged-in user.
app.use('/api', requireUser)
const uid = (req: Request): string => (req as AuthedRequest).userId

// ---- Tool status ----
app.get('/api/toolStatus', async (_req, res) => res.json(await checkTools()))

// ---- Uploads (per user) ----
const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, userUploads(uid(req as Request))),
  filename: (_req, file, cb) => {
    const safe = (file.originalname || 'media').replace(/[^\w.\-]+/g, '_').slice(-60)
    cb(null, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safe}`)
  }
})
const upload = multer({ storage, limits: { fileSize: 16 * 1024 * 1024 * 1024 } })
app.post('/api/upload', upload.single('file'), (req, res) => {
  const f = req.file
  if (!f) {
    res.status(400).json({ error: 'no file' })
    return
  }
  res.json({ path: path.resolve(f.path), name: f.originalname })
})

// Chunked upload (large-file friendly, dodges tunnel body limits)
const chunkUploads = new Map<string, { path: string; userId: string }>()
function sanitizeName(n: string): string {
  return (n || 'media').replace(/[^\w.\-]+/g, '_').slice(-60)
}
app.post('/api/upload-init', (req, res) => {
  const id = randomUUID()
  const p = path.join(userUploads(uid(req)), `${id}-${sanitizeName(req.body?.name)}`)
  fs.writeFileSync(p, '')
  chunkUploads.set(id, { path: p, userId: uid(req) })
  res.json({ uploadId: id, path: p })
})
app.post('/api/upload-chunk', express.raw({ type: 'application/octet-stream', limit: '64mb' }), (req, res) => {
  const u = chunkUploads.get(String(req.query.uploadId || ''))
  if (!u || u.userId !== uid(req)) {
    res.status(404).json({ error: 'unknown upload' })
    return
  }
  try {
    // RESUMABLE: the client says which byte this chunk starts at. On a mismatch
    // (a retried chunk that actually landed, or a dropped one) reply 409 with
    // the real size so the client realigns — a 600MB upload survives flaky
    // tunnel/mobile connections instead of restarting from byte zero.
    const size = fs.statSync(u.path).size
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : NaN
    if (!Number.isNaN(offset) && offset !== size) {
      res.status(409).json({ error: 'offset mismatch', size })
      return
    }
    fs.appendFileSync(u.path, req.body as Buffer)
    res.json({ ok: true, size: size + (req.body as Buffer).length })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})
// Where an interrupted upload left off (client resumes from here).
app.get('/api/upload-status', (req, res) => {
  const u = chunkUploads.get(String(req.query.uploadId || ''))
  if (!u || u.userId !== uid(req)) {
    res.status(404).json({ error: 'unknown upload' })
    return
  }
  try {
    res.json({ size: fs.statSync(u.path).size })
  } catch {
    res.json({ size: 0 })
  }
})
app.post('/api/upload-complete', (req, res) => {
  const id = String(req.body?.uploadId || '')
  const u = chunkUploads.get(id)
  if (!u || u.userId !== uid(req)) {
    res.status(404).json({ error: 'unknown upload' })
    return
  }
  chunkUploads.delete(id)
  res.json({ path: u.path })
})

// ---- Media operations ----
app.post('/api/probe', async (req, res) => {
  try {
    res.json(await probe(assertAllowed(uid(req), req.body?.path)))
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.post('/api/waveform', async (req, res) => {
  try {
    res.json(await extractWaveform(assertAllowed(uid(req), req.body?.path)))
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.post('/api/thumbnails', async (req, res) => {
  try {
    res.json(await extractThumbnails(assertAllowed(uid(req), req.body?.path), req.body?.intervalSec ?? 2))
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.post('/api/silence', async (req, res) => {
  try {
    const userId = uid(req)
    const p = assertAllowed(userId, req.body?.path)
    const regions = await detectSilence(p, req.body?.opts, (pct) =>
      send(userId, { type: 'progress', jobId: 'silence', kind: 'silence', percent: pct })
    )
    res.json(regions)
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.post('/api/transcribe', (req, res) => {
  try {
    const userId = uid(req)
    const p = assertAllowed(userId, req.body?.path)
    const backend = req.body?.backend as TranscribeBackend | undefined
    const modelName = typeof req.body?.modelName === 'string' ? req.body.modelName : undefined
    const jobId = runJob('transcribe', userId, (op) =>
      backend === 'openai'
        ? transcribeOpenAI(p, (pct, msg) => op(pct, msg))
        : modelName === 'parakeet'
          ? transcribeParakeet(p, (pct, msg) => op(pct, msg))
          : transcribe(p, (pct, msg) => op(pct, msg), modelName)
    )
    res.json({ jobId })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.post('/api/suggest-cuts', (req, res) => {
  try {
    const userId = uid(req)
    const transcript = req.body?.transcript as Transcript | undefined
    if (!transcript?.words) throw new Error('No transcript provided')
    const jobId = runJob('transcribe', userId, (op) => suggestCutsAI(transcript, (pct, msg) => op(pct, msg)))
    res.json({ jobId })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.post('/api/fast-cut', (req, res) => {
  try {
    const userId = uid(req)
    const transcript = req.body?.transcript as Transcript | undefined
    if (!transcript?.words) throw new Error('No transcript provided')
    // Optional audio path (uploaded by the client) enables the acoustic tier.
    const audioPath = req.body?.path ? assertAllowed(userId, String(req.body.path)) : undefined
    const script = typeof req.body?.script === 'string' ? req.body.script : undefined
    const jobId = runJob('transcribe', userId, (op) => fastCutSuggest(transcript, audioPath, script, (pct, msg) => op(pct, msg)))
    res.json({ jobId })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
// ---- CutCutPro: 4-phase premium pipeline ----
app.post('/api/cutcutpro', (req, res) => {
  try {
    const userId = uid(req)
    const p = String(req.body?.path || '')
    if (!p) throw new Error('No media path provided')
    assertAllowed(userId, p)
    const transcript = (req.body?.transcript ?? null) as Transcript | null
    const modelName = req.body?.modelName as string | undefined
    const runVad = req.body?.runVad as boolean | undefined
    const script = typeof req.body?.script === 'string' ? req.body.script : undefined
    const jobId = runJob('transcribe', userId, (op) => cutCutPro(p, transcript, modelName, runVad ?? true, script, (pct, msg) => op(pct, msg)))
    res.json({ jobId })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
// ---- Retake-Aware Cut Beta: separate experimental engine ----
app.post('/api/retake-cut', (req, res) => {
  try {
    const userId = uid(req)
    const p = assertAllowed(userId, String(req.body?.path || ''))
    console.log('[retake-aware-beta] job requested (cut_mode: retake_aware_beta)')
    const jobId = runJob('transcribe', userId, (op) => retakeAwareCut(p, (pct, msg) => op(pct, msg)))
    res.json({ jobId, cut_mode: 'retake_aware_beta' })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
// ---- Smart Smooth Cut (beta): AI pause judge + per-run debug dump ----
app.post('/api/cut-judge', async (req, res) => {
  try {
    uid(req)
    const raw = await judgeCuts(req.body?.payload ?? {})
    res.json({ raw })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.post('/api/smartcut-debug', (req, res) => {
  try {
    const userId = uid(req)
    const dir = path.join(userUploads(userId), 'smartsmooth')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, `debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(p, JSON.stringify(req.body?.debug ?? {}, null, 2), 'utf8')
    res.json({ path: p })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.post('/api/generate-overlays', (req, res) => {
  try {
    const userId = uid(req)
    const transcript = req.body?.transcript as Transcript | undefined
    const assets = (req.body?.assets ?? []) as OverlayAsset[]
    const rules = (req.body?.rules ?? []) as OverlayRule[]
    const opts = (req.body?.opts ?? { duration: 0, cuts: [] }) as { duration: number; cuts: { start: number; end: number }[] }
    if (!transcript?.segments) throw new Error('No transcript provided')
    const jobId = runJob('transcribe', userId, (op) =>
      generateOverlayTimeline(transcript, assets, rules, opts, (pct, msg) => op(pct, msg))
    )
    res.json({ jobId })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.get('/api/openai-status', (_req, res) => res.json({ available: openaiAvailable() }))
app.get('/api/whisper-models', (_req, res) => res.json({ models: listWhisperModels() }))
app.post('/api/combine', (req, res) => {
  try {
    const userId = uid(req)
    const clips = req.body?.clips || []
    const audioOnly = !!req.body?.audioOnly
    for (const c of clips) if (c?.sourcePath) assertAllowed(userId, c.sourcePath)
    const jobId = runJob('combine', userId, async (op) => {
      const p = await combineClips(clips, (pct) => op(pct), userUploads(userId), audioOnly)
      const info = await probe(p)
      return { path: p, duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio, hasVideo: info.hasVideo }
    })
    res.json({ jobId })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.post('/api/export', (req, res) => {
  try {
    const userId = uid(req)
    const project: Project = req.body?.project
    const settings = req.body?.settings
    const textOverlays = req.body?.textOverlays
    validateProjectPaths(userId, project)
    const out = path.join(userExports(userId), `${randomUUID()}.mp4`)
    const name = `${(project.name || 'easecutpro-export').replace(/\.[^.]+$/, '')}.mp4`
    const jobId = runJob('export', userId, async (op) => {
      if (project.media?.path) {
        try {
          const m = await probe(project.media.path)
          project.media = {
            ...project.media,
            duration: m.duration || project.media.duration,
            width: m.width || project.media.width,
            height: m.height || project.media.height,
            fps: m.fps || project.media.fps,
            hasAudio: m.hasAudio,
            hasVideo: m.hasVideo
          }
        } catch {
          /* keep client values */
        }
      }
      await exportProject(project, out, settings, textOverlays, (pct) => op(pct))
      return { downloadUrl: `/api/download?p=${encodeURIComponent(out)}`, name }
    })
    res.json({ jobId })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})
app.get('/api/download', (req, res) => {
  try {
    res.download(assertAllowed(uid(req), String(req.query.p || '')))
  } catch {
    res.status(403).end()
  }
})

// ---- Projects (per user) ----
interface ProjectRec {
  id: string
  name: string
  project: Project | null
  thumb: string
  createdAt: number
  updatedAt: number
}
function projectPath(userId: string, id: string): string {
  return path.join(userProjectsDir(userId), `${safeId(id)}.json`)
}
app.get('/api/projects', (req, res) => {
  const dir = userProjectsDir(uid(req))
  const out: Omit<ProjectRec, 'project'>[] = []
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const r: ProjectRec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      out.push({ id: r.id, name: r.name, thumb: r.thumb || '', createdAt: r.createdAt, updatedAt: r.updatedAt })
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  res.json({ projects: out })
})
app.post('/api/projects', (req, res) => {
  const now = Date.now()
  const id = randomUUID()
  const rec: ProjectRec = {
    id,
    name: String(req.body?.name || 'Untitled project').slice(0, 80),
    project: req.body?.project ?? null,
    thumb: '',
    createdAt: now,
    updatedAt: now
  }
  fs.writeFileSync(projectPath(uid(req), id), JSON.stringify(rec))
  res.json({ id, name: rec.name, updatedAt: now })
})
app.get('/api/projects/:id', (req, res) => {
  const p = projectPath(uid(req), req.params.id)
  if (!fs.existsSync(p)) {
    res.status(404).json({ error: 'not found' })
    return
  }
  res.json(JSON.parse(fs.readFileSync(p, 'utf8')))
})
app.put('/api/projects/:id', (req, res) => {
  const p = projectPath(uid(req), req.params.id)
  let rec: ProjectRec
  try {
    rec = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    res.status(404).json({ error: 'not found' })
    return
  }
  if (req.body?.name != null) rec.name = String(req.body.name).slice(0, 80)
  if (req.body?.project != null) rec.project = req.body.project
  if (req.body?.thumb != null) rec.thumb = String(req.body.thumb).slice(0, 400000)
  rec.updatedAt = Date.now()
  fs.writeFileSync(p, JSON.stringify(rec))
  res.json({ ok: true, updatedAt: rec.updatedAt })
})
app.delete('/api/projects/:id', (req, res) => {
  try {
    fs.unlinkSync(projectPath(uid(req), req.params.id))
  } catch {
    /* already gone */
  }
  res.json({ ok: true })
})

// ---- Server-side file browser (optional, EC_BROWSE_ROOTS) ----
const MEDIA_RE = /\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|aac|png|jpe?g|webp|gif|bmp)$/i
app.get('/api/files', (req, res) => {
  const dir = req.query.dir ? String(req.query.dir) : ''
  if (!dir) {
    res.json({ roots: BROWSE_ROOTS, entries: BROWSE_ROOTS.map((r) => ({ name: r, path: r, isDir: true, isMedia: false })) })
    return
  }
  try {
    const abs = assertAllowed(uid(req), dir)
    const entries = fs
      .readdirSync(abs)
      .map((n) => {
        const full = path.join(abs, n)
        try {
          const st = fs.statSync(full)
          return { name: n, path: full, isDir: st.isDirectory(), isMedia: MEDIA_RE.test(n) }
        } catch {
          return null
        }
      })
      .filter((e): e is NonNullable<typeof e> => e != null && (e.isDir || e.isMedia))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    res.json({ dir: abs, parent: path.dirname(abs), entries })
  } catch (e) {
    res.status(403).json({ error: String((e as Error).message) })
  }
})

// ---- WebSocket (progress + job results), scoped per user ----
// Quiet handler for ABORTED request bodies (a phone/tunnel dropping mid-chunk
// is routine, not a crash): reply 400 without the stack-trace spam. Everything
// else keeps the default behaviour.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'request.aborted' || err?.message === 'request aborted') {
    if (!res.headersSent) res.status(400).json({ error: 'request aborted' })
    return
  }
  console.error('[server]', err?.message ?? err)
  if (!res.headersSent) res.status(500).json({ error: String(err?.message ?? err) })
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
const clients = new Set<WebSocket & { userId?: string }>()
wss.on('connection', (ws: WebSocket & { userId?: string }, req) => {
  const u = new URL(req.url || '/', 'http://x')
  const id = userIdFromReq({ headers: req.headers, query: { t: u.searchParams.get('t') } })
  if (!id) {
    ws.close()
    return
  }
  ws.userId = id
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
})
function send(userId: string, obj: unknown): void {
  const s = JSON.stringify(obj)
  for (const c of clients) if (c.userId === userId && c.readyState === WebSocket.OPEN) c.send(s)
}

type ProgressFn = (pct: number, msg?: string) => void

// Finished-job outbox: the WS-only delivery LOST results when the socket was
// down at completion time (tunnel WS drops + phones locking mid-job are
// routine) — the client then waited forever with the UI stuck busy. Results
// are now also buffered here and the client polls /api/job-result as a
// fallback, so a finished job always lands.
const jobOutbox = new Map<string, { userId: string; msg: unknown; at: number }>()
function finishJob(userId: string, jobId: string, msg: unknown): void {
  send(userId, msg)
  jobOutbox.set(jobId, { userId, msg, at: Date.now() })
  const cutoff = Date.now() - 30 * 60_000
  for (const [k, v] of jobOutbox) if (v.at < cutoff) jobOutbox.delete(k)
}
app.get('/api/job-result', (req, res) => {
  const id = String(req.query.id || '')
  const e = jobOutbox.get(id)
  if (!e || e.userId !== uid(req)) {
    res.json({ pending: true })
    return
  }
  jobOutbox.delete(id)
  res.json({ pending: false, msg: e.msg })
})

function runJob(kind: string, userId: string, fn: (op: ProgressFn) => Promise<unknown>): string {
  const jobId = randomUUID()
  setImmediate(async () => {
    console.log(`[job] ${kind} ${jobId} started`)
    try {
      const data = await fn((percent, message) => send(userId, { type: 'progress', jobId, kind, percent, message }))
      console.log(`[job] ${kind} ${jobId} done`)
      finishJob(userId, jobId, { type: 'result', jobId, kind, data })
    } catch (e) {
      console.error(`[job] ${kind} ${jobId} FAILED:`, (e as Error)?.message ?? e)
      finishJob(userId, jobId, { type: 'error', jobId, kind, message: String((e as Error)?.message ?? e) })
    }
  })
  return jobId
}

// ---- Media streaming with HTTP Range ----
function mimeForPath(p: string): string {
  switch (path.extname(p).toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mkv':
      return 'video/x-matroska'
    case '.mov':
      return 'video/quicktime'
    case '.avi':
      return 'video/x-msvideo'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
    case '.aac':
      return 'audio/mp4'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    default:
      return 'application/octet-stream'
  }
}
// Just the AUDIO of a media file, as AAC/m4a (~1.5MB/min) — the on-device
// exporter decodes this in the browser instead of round-tripping the full
// video through the tunnel.
app.get('/api/export-audio', async (req, res) => {
  const userId = userIdFromReq(req)
  if (!userId) {
    res.status(401).end()
    return
  }
  let p: string
  try {
    p = assertAllowed(userId, String(req.query.p || ''))
  } catch {
    res.status(403).end()
    return
  }
  try {
    const out = await extractAudioM4a(p)
    res.setHeader('Content-Type', 'audio/mp4')
    res.sendFile(out, () => {
      try {
        fs.unlinkSync(out)
      } catch {
        /* temp file already gone */
      }
    })
  } catch {
    res.status(422).json({ error: 'no decodable audio stream' })
  }
})

app.get('/media', (req, res) => {
  const userId = userIdFromReq(req)
  if (!userId) {
    res.status(401).end()
    return
  }
  let p: string
  try {
    p = assertAllowed(userId, String(req.query.p || ''))
  } catch {
    res.status(403).end()
    return
  }
  let size: number
  try {
    size = fs.statSync(p).size
  } catch {
    res.status(404).end()
    return
  }
  const type = mimeForPath(p)
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m && m[1] ? parseInt(m[1], 10) : 0
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1
    const e = Math.min(end, size - 1)
    if (start > e) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end()
      return
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${e}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(e - start + 1)
    })
    fs.createReadStream(p, { start, end: e }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(size) })
    fs.createReadStream(p).pipe(res)
  }
})

// ---- Static client + SPA fallback ----
app.use(express.static(RENDERER_DIR))
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/media')) {
    res.status(404).end()
    return
  }
  res.sendFile(path.join(RENDERER_DIR, 'index.html'))
})

// ---- Start ----
function lanIps(): string[] {
  const out: string[] = []
  const ifs = os.networkInterfaces()
  for (const name of Object.keys(ifs)) for (const ni of ifs[name] ?? []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
  return out
}
server.listen(PORT, HOST, () => {
  if (!fs.existsSync(path.join(RENDERER_DIR, 'index.html')))
    console.warn(`\n⚠  No built client at ${RENDERER_DIR}. Run "npm run build" first.\n`)
  console.log('EaseCutPro web server running:')
  console.log(`  local:   http://localhost:${PORT}`)
  for (const ip of lanIps()) console.log(`  network: http://${ip}:${PORT}`)
  console.log(`  work dir: ${WORK}`)
  console.log(`  accounts: ${Object.keys(users).length} · signup ${SIGNUP_CODE ? 'gated by code' : 'OPEN (set EC_SIGNUP_CODE before exposing!)'}`)
  // Warm up the Fast Cut model sidecar so its tiers stay loaded (best-effort).
  void startFastcutSidecar()
})
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) process.on(sig, stopFastcutSidecar)
