// On-device export — orchestrator (main thread).
//
// Renders the timeline document WITHOUT uploading anything: a hidden <video>
// pool seeks each source to the exact frame time (frame N ↔ N / fps — index
// math, never the wall clock), transfers the decoded frame to the encoder
// worker (composite + H.264 + MP4 mux), and mixes the audio offline through an
// OfflineAudioContext (cuts, per-clip speed/gain, audio lanes, music) into AAC.
// A slow or hanging device makes the export take longer; it cannot change the
// output — duration and frame count are exact by construction.
//
// Phase 1 scope: main lane (multi-clip, cuts, speed, gain, mute, Ken Burns),
// audio lanes (detached voice), background music. Text + overlay compositing
// stays on the PC exporter for now — `whyNotLocal` reports the reason and the
// UI falls back to server export.

import { getSharedEngine } from '../timelineEngine'
import { mainTrackId } from '@shared/timeline/model'
import { framesToSeconds } from '@shared/timeline/time'
import { resolveMedia } from '../media/resolver'
import { easeInOut } from '../clock'
import type { Project } from '@shared/types'
import type { TimelineDocument } from '@shared/timeline/types'

const FPS = 30
const AUDIO_RATE = 48000

interface Seg {
  url: string
  sourceStart: number
  sourceEnd: number
  start: number
  len: number
  speed: number
  gain: number
  muted: boolean
  size: number
  zs: number
  ze: number
  ox: number
  oy: number
}

interface AudioClipSched {
  url: string
  start: number
  sourceIn: number
  dur: number
  gain: number
  speed: number
  loop?: boolean
}

// ---- capability ----
let capCache: Promise<boolean> | null = null
/** Can this browser hardware-encode H.264 + AAC? (cached probe) */
export function canEncodeOnDevice(): Promise<boolean> {
  if (capCache) return capCache
  capCache = (async () => {
    try {
      if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') return false
      const v = await VideoEncoder.isConfigSupported({
        codec: 'avc1.640028',
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: FPS
      })
      const a = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: AUDIO_RATE,
        numberOfChannels: 2,
        bitrate: 192_000
      })
      return v.supported === true && a.supported === true
    } catch {
      return false
    }
  })()
  return capCache
}

/** '' when the current timeline can export on-device; else the human reason. */
export function whyNotLocal(project: Project): string {
  const doc = getSharedEngine()?.document
  if (!doc) return 'timeline not ready'
  const main = doc.tracks.find((t) => t.isMain)
  if (!main || !main.clips.length) return 'nothing on the main track'
  if ((project.texts ?? []).length > 0) return 'text overlays render on the PC for now'
  const hasOverlays = doc.tracks.some(
    (t) => !t.isMain && (t.kind === 'video' || t.kind === 'overlay') && t.clips.length > 0
  )
  if (hasOverlays) return 'overlay clips render on the PC for now'
  for (const c of main.clips) {
    if (c.sourcePath && resolveMedia(c.sourcePath).missing) return 'a source file is missing in this browser'
  }
  return ''
}

// ---- doc -> plan ----
function planFromDoc(doc: TimelineDocument, project: Project): { segs: Seg[]; audio: AudioClipSched[]; total: number } {
  const main = doc.tracks.find((t) => t.isMain)
  const tb = doc.timebase
  const segs: Seg[] = []
  for (const c of [...(main?.clips ?? [])].sort((a, b) => a.start - b.start)) {
    if (!c.sourcePath) continue
    const r = resolveMedia(c.sourcePath)
    if (!r.url) continue
    const speed = typeof c.speed === 'number' && c.speed > 0 ? c.speed : 1
    segs.push({
      url: r.url,
      sourceStart: c.sourceIn,
      sourceEnd: c.sourceOut,
      start: framesToSeconds(c.start, tb),
      len: Math.max(0.02, framesToSeconds(c.duration, tb)),
      speed,
      gain: typeof c.gain === 'number' ? c.gain : 1,
      muted: c.audioDetached === true || c.muted === true,
      size: num(c.metadata?.ovScale, 1),
      zs: num(c.metadata?.ovZoomStart, 1),
      ze: num(c.metadata?.ovZoomEnd, 1),
      ox: num(c.metadata?.ovX, 0),
      oy: num(c.metadata?.ovY, 0)
    })
  }
  const total = segs.length ? segs[segs.length - 1].start + segs[segs.length - 1].len : 0

  const audio: AudioClipSched[] = []
  for (const t of doc.tracks) {
    if (t.kind !== 'audio' || t.muted || t.hidden) continue
    for (const c of t.clips) {
      if (!c.sourcePath) continue
      const r = resolveMedia(c.sourcePath)
      if (!r.url) continue
      audio.push({
        url: r.url,
        start: framesToSeconds(c.start, tb),
        sourceIn: c.sourceIn,
        dur: Math.max(0.02, c.sourceOut - c.sourceIn),
        gain: typeof c.gain === 'number' ? c.gain : 1,
        speed: typeof c.speed === 'number' && c.speed > 0 ? c.speed : 1
      })
    }
  }
  const music = project.music
  if (music?.path) {
    const r = resolveMedia(music.path)
    if (r.url) {
      const end = Math.min(music.endAt ?? total, total)
      audio.push({
        url: r.url,
        start: Math.max(0, music.startAt),
        sourceIn: 0,
        dur: Math.max(0.02, end - Math.max(0, music.startAt)),
        gain: music.gain,
        speed: 1,
        loop: music.loop
      })
    }
  }
  return { segs, audio, total }
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' ? v : d
}

// ---- audio (offline mix -> AudioData chunks) ----
async function renderAudio(
  segs: Seg[],
  extra: AudioClipSched[],
  total: number,
  onProgress: (p: number) => void
): Promise<AudioBuffer | null> {
  const frames = Math.max(1, Math.ceil(total * AUDIO_RATE))
  const off = new OfflineAudioContext(2, frames, AUDIO_RATE)
  const cache = new Map<string, AudioBuffer>()
  const decode = async (url: string): Promise<AudioBuffer | null> => {
    if (cache.has(url)) return cache.get(url)!
    try {
      const ab = await (await fetch(url)).arrayBuffer()
      const buf = await off.decodeAudioData(ab)
      cache.set(url, buf)
      return buf
    } catch {
      return null // e.g. an image, or an undecodable container
    }
  }
  let any = false
  for (const s of segs) {
    if (s.muted) continue
    const buf = await decode(s.url)
    if (!buf) continue
    any = true
    const node = off.createBufferSource()
    node.buffer = buf
    node.playbackRate.value = s.speed
    const g = off.createGain()
    g.gain.value = Math.max(0, s.gain)
    node.connect(g).connect(off.destination)
    node.start(s.start, s.sourceStart, Math.max(0.01, s.sourceEnd - s.sourceStart))
  }
  for (const a of extra) {
    const buf = await decode(a.url)
    if (!buf) continue
    any = true
    const node = off.createBufferSource()
    node.buffer = buf
    node.loop = !!a.loop
    node.playbackRate.value = a.speed
    const g = off.createGain()
    g.gain.value = Math.max(0, a.gain)
    node.connect(g).connect(off.destination)
    if (a.loop) {
      node.start(a.start)
      node.stop(Math.min(total, a.start + a.dur))
    } else {
      node.start(a.start, a.sourceIn, a.dur)
    }
  }
  if (!any) return null
  onProgress(4)
  return off.startRendering()
}

// ---- the export ----
const dbg = (...a: unknown[]): void => console.log('[ondevice]', ...a)

export async function exportOnDevice(
  project: Project,
  opts: { width: number; height: number; bitrateMbps: number },
  onProgress: (pct: number, msg: string) => void
): Promise<{ blob: Blob; name: string }> {
  const doc = getSharedEngine()?.document
  if (!doc) throw new Error('timeline not ready')
  const gate = whyNotLocal(project)
  if (gate) throw new Error(gate)
  const { segs, audio, total } = planFromDoc(doc, project)
  if (!segs.length || total <= 0) throw new Error('nothing to export')

  const W = Math.max(16, Math.round(opts.width / 2) * 2)
  const H = Math.max(16, Math.round(opts.height / 2) * 2)
  const totalFrames = Math.max(1, Math.round(total * FPS))

  onProgress(1, 'Preparing on-device export…')
  dbg('plan', { segs: segs.length, audio: audio.length, total, W, H, totalFrames })

  // 1) audio first (fast, and the encoder drains it while frames trickle in)
  dbg('renderAudio: start')
  const audioBuf = await renderAudio(segs, audio, total, (p) => onProgress(p, 'Mixing audio…'))
  dbg('renderAudio: done', !!audioBuf)

  // 2) worker
  const worker = new Worker(new URL('./encoderWorker.ts', import.meta.url), { type: 'module' })
  const fail = (m: string): void => {
    try {
      worker.terminate()
    } catch {
      /* gone */
    }
    throw new Error(m)
  }
  let ackResolve: (() => void) | null = null
  let lastQueue = 0
  let workerError: string | null = null
  const done = new Promise<ArrayBuffer>((resolve, reject) => {
    worker.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'ack') {
        lastQueue = m.queue
        ackResolve?.()
        ackResolve = null
      } else if (m.type === 'done') resolve(m.buffer)
      else if (m.type === 'error') {
        workerError = m.error
        reject(new Error(m.error))
      }
    }
    worker.onerror = (e) => reject(new Error(e.message))
  })
  const ready = new Promise<void>((resolve) => {
    const orig = worker.onmessage!
    worker.onmessage = (ev) => {
      if (ev.data?.type === 'ready') {
        worker.onmessage = orig
        resolve()
        return
      }
      ;(orig as (e: MessageEvent) => void)(ev)
    }
  })
  worker.postMessage({
    type: 'init',
    width: W,
    height: H,
    fps: FPS,
    videoCodec: 'avc1.640028',
    bitrate: Math.round(opts.bitrateMbps * 1_000_000),
    audio: audioBuf ? { codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, channels: 2, bitrate: 192_000 } : null
  })
  dbg('worker init sent')
  await ready
  dbg('worker ready')

  // 3) stream the audio (planar f32 chunks; index-based timestamps)
  if (audioBuf) {
    const CH = 2
    const CHUNK = 4096
    const ch0 = audioBuf.getChannelData(0)
    const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : ch0
    for (let o = 0; o < audioBuf.length; o += CHUNK) {
      const n = Math.min(CHUNK, audioBuf.length - o)
      const planar = new Float32Array(n * CH)
      planar.set(ch0.subarray(o, o + n), 0)
      planar.set(ch1.subarray(o, o + n), n)
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: AUDIO_RATE,
        numberOfFrames: n,
        numberOfChannels: CH,
        timestamp: Math.round((o / AUDIO_RATE) * 1e6),
        data: planar
      })
      worker.postMessage({ type: 'audio', data }, [data as unknown as Transferable])
    }
  }

  dbg('audio streamed')
  // 4) video pool (one hidden element per unique source)
  const pool = new Map<string, HTMLVideoElement>()
  for (const url of new Set(segs.map((s) => s.url))) {
    const v = document.createElement('video')
    v.src = url
    v.muted = true
    v.preload = 'auto'
    ;(v as unknown as { playsInline: boolean }).playsInline = true
    v.style.display = 'none'
    document.body.appendChild(v)
    await new Promise<void>((res, rej) => {
      // wait for a DECODED frame (readyState >= 2) — VideoFrame(video) throws
      // InvalidStateError on a metadata-only element.
      v.onloadeddata = () => res()
      v.onerror = () => rej(new Error('cannot open a source in this browser'))
      if (v.readyState >= 2) res()
    })
    pool.set(url, v)
  }
  const seekTo = (v: HTMLVideoElement, t: number): Promise<void> =>
    new Promise((res) => {
      const to = setTimeout(() => {
        v.removeEventListener('seeked', on)
        res() // decoder stall: use whatever frame is there rather than wedging
      }, 2000)
      const on = (): void => {
        clearTimeout(to)
        v.removeEventListener('seeked', on)
        res()
      }
      v.addEventListener('seeked', on)
      v.currentTime = t
    })

  dbg('pool ready')
  // 5) frame loop — offline, sequential, index-timestamped
  try {
    for (let n = 0; n < totalFrames; n++) {
      if (workerError) fail(workerError)
      const t = (n + 0.0001) / FPS
      const seg = segs.find((s) => t >= s.start && t < s.start + s.len)
      if (!seg) {
        worker.postMessage({ type: 'frame', n, frame: null })
      } else {
        const v = pool.get(seg.url)!
        const want = Math.min(seg.sourceEnd - 0.001, seg.sourceStart + (t - seg.start) * seg.speed)
        if (Math.abs(v.currentTime - want) > 1 / (FPS * 2)) await seekTo(v, want)
        if (v.readyState < 2) {
          await new Promise<void>((res) => {
            const to = setTimeout(res, 2000)
            v.onloadeddata = () => {
              clearTimeout(to)
              res()
            }
          })
        }
        const frame = new VideoFrame(v, { timestamp: 0 })
        // contain-fit + eased Ken Burns (same math as the preview + PC export)
        const vw = v.videoWidth || W
        const vh = v.videoHeight || H
        const s = Math.min(W / vw, H / vh)
        const dw = vw * s
        const dh = vh * s
        const prog = seg.len > 0 ? Math.min(1, Math.max(0, (t - seg.start) / seg.len)) : 0
        const scale = seg.size * (seg.zs + (seg.ze - seg.zs) * easeInOut(prog))
        worker.postMessage(
          {
            type: 'frame',
            n,
            frame,
            fit: {
              dx: (W - dw) / 2,
              dy: (H - dh) / 2,
              dw,
              dh,
              scale,
              ox: W * (0.5 + seg.ox),
              oy: H * (0.5 + seg.oy)
            }
          },
          [frame as unknown as Transferable]
        )
      }
      // backpressure: never let the encoder queue run away
      if (lastQueue > 8) await new Promise<void>((res) => (ackResolve = res))
      if (n % 15 === 0) onProgress(5 + Math.round((n / totalFrames) * 90), `Encoding on this device… ${Math.round((n / totalFrames) * 100)}%`)
    }
    dbg('frames done')
    worker.postMessage({ type: 'finish' })
    onProgress(96, 'Finishing the file…')
    const buffer = await done
    const name = `${(project.name || 'export').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[^.]+$/, '')}-ondevice.mp4`
    return { blob: new Blob([buffer], { type: 'video/mp4' }), name }
  } catch (e) {
    dbg('FAILED', (e as Error).message)
    throw e
  } finally {
    for (const v of pool.values()) {
      v.removeAttribute('src')
      v.load()
      v.remove()
    }
    setTimeout(() => worker.terminate(), 1000)
  }
}
