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
// Scope: main lane (multi-clip, cuts, speed, gain, mute, Ken Burns, image
// clips), overlay lanes (image + video b-roll with crop/Ken Burns), baked text
// overlays, audio lanes (detached voice), background music. Compositing math
// mirrors the preview (OverlayLayer/TextLayer) and the PC text bake — see
// export/overlays.ts. `whyNotLocal` refuses only timelines whose source files
// are genuinely missing in this browser.

import { getSharedEngine } from '../timelineEngine'
import { mainTrackId } from '@shared/timeline/model'
import { framesToSeconds } from '@shared/timeline/time'
import { resolveMedia } from '../media/resolver'
import { isWebMediaId, getFile } from '../webmedia'
import { IS_WEB } from '../platform'
import { easeInOut } from '../clock'
import {
  planOverlays,
  planTexts,
  overlayRect,
  fullFrameRect,
  bakeTextBitmap,
  loadImageBitmap
} from './overlays'
import type { OverlayClipSpec, OverlayRect } from './overlays'
import type { Project } from '@shared/types'
import type { TimelineDocument } from '@shared/timeline/types'

export const FPS = 30
const AUDIO_RATE = 48000

/** Friendly, rotating export status lines (the % is shown separately in the UI). */
export const EXPORT_MSGS = ['Compiling your video…', 'Rendering frames…', 'Polishing video…', 'Almost there…']
export function exportMsg(frac: number): string {
  return EXPORT_MSGS[Math.min(EXPORT_MSGS.length - 1, Math.max(0, Math.floor(frac * EXPORT_MSGS.length)))]
}

export interface Seg {
  url: string
  /** the clip's original source path/id — the audio decoder keys off this. */
  src: string
  sourceStart: number
  sourceEnd: number
  start: number
  len: number
  speed: number
  gain: number
  muted: boolean
  hasAudio: boolean
  /** image clip on the main lane — rendered from a decoded bitmap, no <video>. */
  isImage: boolean
  size: number
  zs: number
  ze: number
  ox: number
  oy: number
}

export interface AudioClipSched {
  url: string
  src: string
  start: number
  sourceIn: number
  dur: number
  gain: number
  speed: number
  loop?: boolean
}

// ---- capability ----
export interface EncodeCaps {
  /** this browser can H.264-encode video on-device */
  video: boolean
  /** this browser can AAC-encode audio on-device. FALSE on iOS/iPadOS Safari
   *  (and every iOS browser — all WebKit) before v26: WebCodecs shipped there
   *  VIDEO-ONLY, so AudioEncoder/AudioData are `undefined`. When false we export
   *  video-only instead of refusing the whole export. */
  audio: boolean
  /** the H.264 profile string that probed supported (High → Main → Baseline). */
  videoCodec: string
}

// High@4.0, Main@4.0, Constrained-Baseline@4.0, Baseline@3.1. Safari REJECTS
// (throws) an unsupported config instead of returning {supported:false}, and
// some iOS builds only advertise the lower profiles — so we walk the list and
// take the first that sticks rather than hard-coding High.
const H264_PROFILES = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f']

let capsCache: Promise<EncodeCaps> | null = null
/** What can this browser encode on-device? (cached probe) */
export function probeEncodeCaps(): Promise<EncodeCaps> {
  if (capsCache) return capsCache
  capsCache = (async (): Promise<EncodeCaps> => {
    let video = false
    let videoCodec = H264_PROFILES[0]
    if (typeof VideoEncoder !== 'undefined') {
      for (const codec of H264_PROFILES) {
        try {
          const v = await VideoEncoder.isConfigSupported({
            codec,
            width: 1920,
            height: 1080,
            bitrate: 8_000_000,
            framerate: FPS
          })
          if (v.supported === true) {
            video = true
            videoCodec = codec
            break
          }
        } catch {
          /* Safari throws on an unsupported config — try the next profile */
        }
      }
    }
    // AudioData must exist too: the main thread builds `new AudioData(...)` to
    // feed the encoder, and it's undefined exactly where AudioEncoder is.
    let audio = false
    if (typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
      try {
        const a = await AudioEncoder.isConfigSupported({
          codec: 'mp4a.40.2',
          sampleRate: AUDIO_RATE,
          numberOfChannels: 2,
          bitrate: 192_000
        })
        audio = a.supported === true
      } catch {
        audio = false
      }
    }
    return { video, audio, videoCodec }
  })()
  return capsCache
}

/** '' when the current timeline can export on-device; else the human reason. */
export function whyNotLocal(project: Project): string {
  const doc = getSharedEngine()?.document
  if (!doc) return 'timeline not ready'
  const main = doc.tracks.find((t) => t.isMain)
  if (!main || !main.clips.length) return 'nothing on the main track'
  // Text and overlay lanes composite here now; the only honest refusal left is
  // a source whose file this browser can't reach (main + visible overlay
  // lanes — text clips have no source, audio lanes fail loudly at decode time).
  for (const t of doc.tracks) {
    if (t.hidden || !(t.isMain || t.kind === 'video')) continue
    for (const c of t.clips) {
      if (c.sourcePath && resolveMedia(c.sourcePath).missing) return 'a source file is missing in this browser'
    }
  }
  return ''
}

// ---- doc -> plan ----
export function planFromDoc(doc: TimelineDocument, project: Project): { segs: Seg[]; audio: AudioClipSched[]; total: number } {
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
      src: c.sourcePath,
      sourceStart: c.sourceIn,
      sourceEnd: c.sourceOut,
      start: framesToSeconds(c.start, tb),
      len: Math.max(0.02, framesToSeconds(c.duration, tb)),
      speed,
      gain: typeof c.gain === 'number' ? c.gain : 1,
      muted: c.audioDetached === true || c.muted === true,
      hasAudio: c.kind !== 'image' && c.hasAudio !== false,
      isImage: c.kind === 'image',
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
        src: c.sourcePath,
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
        src: music.path,
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

// Equal-power crossfade at cut seams: consecutive kept segments overlap by a few
// tens of ms with cos/sin gain ramps (constant power → no volume dip, no click at
// the splice). NON-DRIFTING: the segment BODIES still butt-join exactly, so audio
// stays locked to the (hard-cut) video — only the short fade tails bleed into the
// removed region. Total mix length is unchanged.
const XFADE_S = 0.05 // total crossfade width (s); half extends past each seam side

/** cos/sin ramp of `n` points scaled to `base`: 'in' = 0→base (sin), 'out' =
 *  base→0 (cos). Equal power because in(t)²+out(t)²=base² at every matching t. */
export function equalPowerRamp(base: number, dir: 'in' | 'out', n = 64): Float32Array {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1) // 0→1
    a[i] = base * (dir === 'in' ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2))
  }
  return a
}

// ---- audio (offline mix -> AudioData chunks) ----
export async function renderAudio(
  segs: Seg[],
  extra: AudioClipSched[],
  total: number,
  onProgress: (p: number) => void
): Promise<AudioBuffer | null> {
  const frames = Math.max(1, Math.ceil(total * AUDIO_RATE))
  const off = new OfflineAudioContext(2, frames, AUDIO_RATE)
  // Decode on a LIVE AudioContext, NOT `off`: iOS's OfflineAudioContext.decodeAudioData
  // silently yields SILENCE (the same bug that blanked the waveform), which shipped
  // audio-less exports on iPhone. Each decoded buffer auto-resamples into `off`'s rate
  // when it's played through a BufferSource, so the mix stays correct everywhere.
  const LiveAC: typeof AudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const dec: { ctx: AudioContext | null } = { ctx: null }
  const decodeCtx = (): AudioContext => {
    if (!dec.ctx) dec.ctx = new LiveAC()
    return dec.ctx
  }
  const cache = new Map<string, AudioBuffer | null>()
  // Get the source's audio bytes the CHEAPEST reliable way:
  //  1. a browser-local File → read it directly (no fetch; blob-URL fetch is
  //     blocked in some shells and copies the whole video anyway),
  //  2. a server path on web → ask the PC for just the extracted audio
  //     (~1.5MB/min) — round-tripping a 100MB+ video through a tunnel is what
  //     made tunnel exports silently lose their audio,
  //  3. otherwise (Electron, or an old server without the endpoint) → fetch the
  //     full media URL as before.
  const decode = async (src: string, url: string): Promise<AudioBuffer | null> => {
    if (cache.has(src)) return cache.get(src) ?? null
    let buf: AudioBuffer | null = null
    try {
      let ab: ArrayBuffer | null = null
      if (isWebMediaId(src)) {
        const f = getFile(src)
        if (f) ab = await f.arrayBuffer()
      } else if (IS_WEB) {
        try {
          const r = await fetch(`/api/export-audio?p=${encodeURIComponent(src)}`, { credentials: 'include' })
          if (r.ok) ab = await r.arrayBuffer()
        } catch {
          /* older server / network hiccup — full-file fallback below */
        }
      }
      if (!ab) ab = await (await fetch(url)).arrayBuffer()
      buf = await decodeCtx().decodeAudioData(ab)
    } catch {
      buf = null // undecodable container, dead URL, or decode OOM
    }
    cache.set(src, buf)
    return buf
  }
  let failed = 0
  // Decode + collect the AUDIBLE main-lane segments in timeline order, so the
  // crossfade can see each seam's neighbours.
  const audible: { s: Seg; buf: AudioBuffer }[] = []
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    if (s.muted || !s.hasAudio) continue
    const buf = await decode(s.src, s.url)
    if (!buf) {
      failed++
      continue
    }
    audible.push({ s, buf })
  }

  // Per-seam crossfade extent `e` (output seconds), symmetric + shared by both
  // sides so the fades sum to constant power. Skipped for seamless same-source
  // joins (splits — already continuous) and clamped so a fade tail never runs off
  // its buffer or replays kept audio across a same-source gap.
  const HALF = XFADE_S / 2
  const contiguous = (a: Seg, b: Seg): boolean =>
    a.src === b.src && Math.abs(a.sourceEnd - b.sourceStart) < 0.003 && Math.abs(a.speed - b.speed) < 1e-3
  const leadE = new Array<number>(audible.length).fill(0)
  const trailE = new Array<number>(audible.length).fill(0)
  for (let i = 0; i + 1 < audible.length; i++) {
    const A = audible[i]
    const B = audible[i + 1]
    if (contiguous(A.s, B.s)) continue
    const spA = Math.max(0.01, A.s.speed)
    const spB = Math.max(0.01, B.s.speed)
    let e = HALF
    e = Math.min(e, Math.max(0, (A.buf.duration - A.s.sourceEnd) / spA)) // A tail room in its buffer
    e = Math.min(e, Math.max(0, B.s.sourceStart / spB)) // B head room in its buffer
    if (A.s.src === B.s.src) {
      // same source: keep both fade tails inside the REMOVED gap (never replay kept audio)
      e = Math.min(e, Math.max(0, B.s.sourceStart - A.s.sourceEnd) / Math.max(spA, spB) / 2)
    }
    e = Math.min(e, A.s.len / 2, B.s.len / 2) // never exceed either body
    if (e < 0.004) continue // too small to matter — leave the butt-join
    trailE[i] = e
    leadE[i + 1] = e
  }

  // Schedule each audible segment, extending its fade tails into the seam and
  // ramping the gain with equal power.
  for (let i = 0; i < audible.length; i++) {
    const { s, buf } = audible[i]
    const sp = Math.max(0.01, s.speed)
    const he = leadE[i]
    const te = trailE[i]
    const bodyEnd = s.start + s.len
    const node = off.createBufferSource()
    node.buffer = buf
    node.playbackRate.value = sp
    const g = off.createGain()
    const base = Math.max(0, s.gain)
    // fade IN over [start-he, start+he]; hold at base; fade OUT over [end-te, end+te]
    if (he > 0) g.gain.setValueCurveAtTime(equalPowerRamp(base, 'in'), s.start - he, 2 * he)
    else g.gain.setValueAtTime(base, Math.max(0, s.start))
    if (te > 0) g.gain.setValueCurveAtTime(equalPowerRamp(base, 'out'), bodyEnd - te, 2 * te)
    node.connect(g).connect(off.destination)
    node.start(
      Math.max(0, s.start - he),
      Math.max(0, s.sourceStart - he * sp),
      Math.max(0.01, s.sourceEnd - s.sourceStart + (he + te) * sp)
    )
  }
  let any = audible.length > 0
  for (const a of extra) {
    const buf = await decode(a.src, a.url)
    if (!buf) {
      failed++
      continue
    }
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
  if (dec.ctx) {
    try {
      dec.ctx.close() // decoding is done; free the live context (iOS caps how many exist)
    } catch {
      /* already closed */
    }
  }
  // HONEST failure: never silently ship a video without its sound. If a source
  // that should contribute audio couldn't be decoded, fail the export so the UI
  // says so (and suggests the PC export) instead of muxing a silent file.
  if (failed > 0) throw new Error(`couldn't read the audio of ${failed} source${failed > 1 ? 's' : ''} in this browser`)
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
  const caps = await probeEncodeCaps()
  if (!caps.video) throw new Error('this browser can’t encode video on-device')
  // iOS/iPadOS Safari < 26 ships WebCodecs video-only (no AudioEncoder). Route to
  // the Mediabunny exporter, which polyfills AAC with a WASM encoder so the export
  // keeps its audio. Everything below stays the proven mp4-muxer path used by every
  // other browser (Android/desktop/iOS 26+), unchanged.
  if (!caps.audio) {
    const { exportOnDeviceMB } = await import('./localExportMB')
    return exportOnDeviceMB(project, opts, onProgress)
  }
  const { segs, audio, total } = planFromDoc(doc, project)
  if (!segs.length || total <= 0) throw new Error('nothing to export')

  const W = Math.max(16, Math.round(opts.width / 2) * 2)
  const H = Math.max(16, Math.round(opts.height / 2) * 2)
  const totalFrames = Math.max(1, Math.round(total * FPS))

  onProgress(1, 'Getting ready to export…')
  dbg('plan', { segs: segs.length, audio: audio.length, total, W, H, totalFrames })

  // 1) audio first (fast, and the encoder drains it while frames trickle in)
  dbg('renderAudio: start')
  const audioBuf = await renderAudio(segs, audio, total, (p) => onProgress(p, 'Mixing your audio…'))
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
    videoCodec: caps.videoCodec,
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
  // 4) compositing plan + source pools. Baked bitmaps (text, image overlays,
  //    main-lane images) are TRANSFERRED to the worker once and drawn there on
  //    every frame of their window; the worker closes each when its window
  //    ends. Video overlays keep a hidden element here and ship one VideoFrame
  //    per output frame instead. (Pools fill inside the try so a source that
  //    refuses to open still tears everything down.)
  const texts = planTexts(doc)
  const overlays = planOverlays(doc)
  const ovVideos: Array<{ spec: OverlayClipSpec; v: HTMLVideoElement; rect: OverlayRect }> = []
  const mainImages = new Map<string, { id: number; w: number; h: number }>()
  const pool = new Map<string, HTMLVideoElement>()
  const openVideo = async (url: string): Promise<HTMLVideoElement> => {
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
    return v
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

  // 5) frame loop — offline, sequential, index-timestamped. Source frames come
  //    from PLAY-HARVEST by default: each segment plays ONCE (muted, at the
  //    clip's speed) while requestVideoFrameCallback captures presented frames
  //    — one seek per SEGMENT. The old per-FRAME seeking cost 100-300ms per
  //    output frame on weak phones (3-9x slower than realtime); it remains only
  //    as the fallback when rVFC is unavailable, the tab is hidden (rVFC stops
  //    firing), or the harvest stalls. Exactness is unchanged either way:
  //    output frame N carries timestamp N/fps and shows the presented source
  //    frame nearest its mapped time — the same frame a seek would land on.
  const rvfcOK =
    typeof (HTMLVideoElement.prototype as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === 'function'
  const frameDur = 1 / FPS
  interface Grab {
    frame: VideoFrame
    t: number
  }
  let buf: Grab[] = []
  const harvest: { stop: null | (() => void) } = { stop: null }
  let curSeg: Seg | null = null
  let lastWant = 0
  // TRUE source frame spacing (min observed gap between presented frames): weak
  // devices DROP presented frames under load, so the average presented spacing
  // lies — the minimum doesn't. Any harvested frame further than ~1.3 true
  // spacings from its exact time is rejected and that ONE frame is seeked
  // instead, so a struggling device degrades to slow-but-correct, never to
  // frozen/wrong frames (the failure mode of realtime capture). 0 = unmeasured.
  let minSpacing = 0
  let prevPresentedT = -1
  const grabTolerance = (): number => Math.max(frameDur, minSpacing || frameDur) * 1.3
  let fallbacks = 0 // per-segment; too many → the harvest is thrash, go pure seek
  let segHarvesting = false
  const closeBuf = (): void => {
    for (const g of buf) g.frame.close()
    buf = []
  }
  const startHarvest = (v: HTMLVideoElement): void => {
    let live = true
    const rvfc = (cb: (now: number, meta: { mediaTime: number }) => void): void =>
      (v as unknown as { requestVideoFrameCallback: (cb: unknown) => void }).requestVideoFrameCallback(cb)
    const tick = (_now: number, meta: { mediaTime: number }): void => {
      if (!live) return
      try {
        buf.push({ frame: new VideoFrame(v, { timestamp: 0 }), t: meta.mediaTime })
        const gap = prevPresentedT >= 0 ? meta.mediaTime - prevPresentedT : 0
        if (gap > 0.0005) {
          const clamped = Math.max(1 / 120, gap)
          minSpacing = minSpacing === 0 ? clamped : Math.min(minSpacing, clamped)
        }
        prevPresentedT = meta.mediaTime
      } catch {
        /* decoder hiccup — the consumer's seek fallback covers it */
      }
      while (buf.length > 4) buf.shift()!.frame.close()
      // Don't decode ahead of consumption (the encoder may be the slow side);
      // the consumer resumes playback when it needs more.
      if (meta.mediaTime > lastWant + 0.5) {
        try {
          v.pause()
        } catch {
          /* ignore */
        }
      }
      rvfc(tick)
    }
    rvfc(tick)
    harvest.stop = () => {
      live = false
      harvest.stop = null
    }
  }
  const waitPresented = async (v: HTMLVideoElement, want: number): Promise<void> => {
    const deadline = performance.now() + 1500
    while (performance.now() < deadline) {
      const latest = buf[buf.length - 1]
      if (latest && latest.t >= want - frameDur / 4) return
      if (v.ended) return
      if (v.paused) {
        try {
          await v.play()
        } catch {
          return // playback refused — seek fallback takes over
        }
      }
      await new Promise((r) => setTimeout(r, 12))
    }
  }
  // ONLY a frame within tolerance of the exact source time counts — a presented
  // stream that skipped `want` (dropped frame) returns null and the caller
  // seeks. Never "nearest available": that is where freezes come from.
  const pickGrab = (want: number): Grab | null => {
    const tol = grabTolerance()
    let best: Grab | null = null
    for (const g of buf) {
      if (g.t > want + frameDur / 4) continue
      if (want - g.t > tol) continue
      if (!best || g.t > best.t) best = g
    }
    return best
  }
  // contain-fit + eased Ken Burns (same math as the preview + PC export);
  // vw/vh = the source's natural size (video element or decoded image bitmap).
  const fitFor = (
    seg: Seg,
    vw: number,
    vh: number,
    t: number
  ): { dx: number; dy: number; dw: number; dh: number; scale: number; ox: number; oy: number } => {
    const s = Math.min(W / vw, H / vh)
    const dw = vw * s
    const dh = vh * s
    const prog = seg.len > 0 ? Math.min(1, Math.max(0, (t - seg.start) / seg.len)) : 0
    return {
      dx: (W - dw) / 2,
      dy: (H - dh) / 2,
      dw,
      dh,
      scale: seg.size * (seg.zs + (seg.ze - seg.zs) * easeInOut(prog)),
      ox: W * (0.5 + seg.ox),
      oy: H * (0.5 + seg.oy)
    }
  }
  const tExport0 = performance.now()
  try {
    // sprites: image overlays first (z = plan order) …
    let spriteId = 0
    for (const o of overlays) {
      if (!o.isImage) continue
      let bmp: ImageBitmap
      try {
        bmp = await loadImageBitmap(o.url)
      } catch {
        throw new Error('cannot open an overlay image in this browser')
      }
      const zoom =
        Math.abs(o.zs - 1) > 0.001 || Math.abs(o.ze - 1) > 0.001
          ? { zs: o.zs, ze: o.ze, start: o.start, len: o.rampLen }
          : null
      worker.postMessage(
        { type: 'sprite', id: spriteId++, bitmap: bmp, z: o.z, start: o.start, end: o.end, rect: overlayRect(W, H, o), clip: true, zoom },
        [bmp]
      )
    }
    // … then text bakes, stacked ABOVE every overlay (preview order: TextLayer
    // renders after OverlayLayer) via a large z offset.
    for (const tc of texts) {
      const bmp = await bakeTextBitmap(tc, W, H)
      worker.postMessage(
        { type: 'sprite', id: spriteId, bitmap: bmp, z: 1e6 + spriteId, start: tc.start, end: tc.end, rect: fullFrameRect(W, H), clip: false, zoom: null },
        [bmp]
      )
      spriteId++
    }
    // main-lane image clips: a <video> can't open them — decode once per unique
    // source; the frame loop draws the asset with the same contain-fit + Ken
    // Burns a video frame gets.
    let assetId = 0
    for (const url of new Set(segs.filter((s) => s.isImage).map((s) => s.url))) {
      let bmp: ImageBitmap
      try {
        bmp = await loadImageBitmap(url)
      } catch {
        throw new Error('cannot open an image in this browser')
      }
      const rec = { id: assetId++, w: bmp.width, h: bmp.height } // size read BEFORE the transfer detaches it
      mainImages.set(url, rec)
      worker.postMessage({ type: 'asset', id: rec.id, bitmap: bmp }, [bmp])
    }
    // hidden elements: one per unique main-lane video source; one per VIDEO
    // overlay CLIP (an overlay can reuse a main source at a different time, so
    // overlay elements are never shared by URL).
    for (const url of new Set(segs.filter((s) => !s.isImage).map((s) => s.url))) pool.set(url, await openVideo(url))
    for (const o of overlays) {
      if (o.isImage) continue
      ovVideos.push({ spec: o, v: await openVideo(o.url), rect: overlayRect(W, H, o) })
    }
    dbg('pool ready', { sprites: spriteId, images: mainImages.size, videoOverlays: ovVideos.length })
    for (let n = 0; n < totalFrames; n++) {
      if (workerError) fail(workerError)
      const t = (n + 0.0001) / FPS
      // video-overlay harvests for THIS output frame — plain per-frame seek
      // (b-roll windows are short; the main lane's play-harvest speed machinery
      // isn't worth its complexity here, and exactness is identical).
      const ovs: Array<{ frame: VideoFrame; z: number; rect: OverlayRect; scale: number }> = []
      for (const o of ovVideos) {
        const sp = o.spec
        if (t < sp.start || t >= sp.end) continue
        const owant = Math.min(sp.sourceIn + sp.rampLen - 0.001, sp.sourceIn + (t - sp.start))
        if (Math.abs(o.v.currentTime - owant) > 1 / (FPS * 2)) await seekTo(o.v, owant)
        if (o.v.readyState < 2) {
          await new Promise<void>((res) => {
            const to = setTimeout(res, 2000)
            o.v.onloadeddata = () => {
              clearTimeout(to)
              res()
            }
          })
        }
        try {
          ovs.push({
            frame: new VideoFrame(o.v, { timestamp: 0 }),
            z: sp.z,
            rect: o.rect,
            // eased Ken Burns for this frame (preview twin: OverlayBox zoomFromProg)
            scale: sp.zs + (sp.ze - sp.zs) * easeInOut((t - sp.start) / sp.rampLen)
          })
        } catch {
          /* decoder hiccup — drop this overlay for one frame, not the export */
        }
      }
      const ovT = ovs.map((g) => g.frame as unknown as Transferable)
      const seg = segs.find((s) => t >= s.start && t < s.start + s.len)
      if (!seg) {
        worker.postMessage({ type: 'frame', n, frame: null, ovs }, ovT)
      } else if (seg.isImage) {
        // main-lane image: the decoded asset stands in for the video frame —
        // no harvest machinery, the worker draws it by id with the same fit.
        if (seg !== curSeg) {
          harvest.stop?.()
          closeBuf()
          curSeg = seg
          segHarvesting = false
        }
        const a = mainImages.get(seg.url)!
        worker.postMessage(
          { type: 'frame', n, frame: null, imageId: a.id, fit: fitFor(seg, a.w || W, a.h || H, t), ovs },
          ovT
        )
      } else {
        const v = pool.get(seg.url)!
        const want = Math.min(seg.sourceEnd - 0.001, seg.sourceStart + (t - seg.start) * seg.speed)
        lastWant = want
        if (seg !== curSeg) {
          // Segment switch: the ONE seek, then play-harvest from here.
          harvest.stop?.()
          closeBuf()
          curSeg = seg
          minSpacing = 0
          prevPresentedT = -1
          fallbacks = 0
          segHarvesting = rvfcOK
          try {
            v.pause()
          } catch {
            /* ignore */
          }
          if (Math.abs(v.currentTime - want) > 1 / (FPS * 2)) await seekTo(v, want)
          if (segHarvesting) {
            try {
              v.playbackRate = Math.min(4, Math.max(0.25, seg.speed))
            } catch {
              /* rate unsupported — plays at 1x; exactness check still holds */
            }
            startHarvest(v)
            try {
              await v.play()
            } catch {
              segHarvesting = false // refused — pure seek for this segment
            }
          }
        }
        let frame: VideoFrame | null = null
        if (segHarvesting && !document.hidden) {
          await waitPresented(v, want)
          const g = pickGrab(want)
          if (g) frame = g.frame.clone() // buf keeps the original: the next output frame may reuse it
        }
        if (!frame) {
          // SEEK for this frame: the presented stream skipped it (dropped
          // frame), the harvest stalled, rVFC is unavailable, or the tab is
          // hidden. Exactness beats speed.
          try {
            v.pause()
          } catch {
            /* ignore */
          }
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
          frame = new VideoFrame(v, { timestamp: 0 })
          if (segHarvesting) {
            // A device dropping frames this often gains nothing from the
            // harvest — stop fighting it and stay in seek mode for the rest of
            // this segment.
            if (++fallbacks > 10) {
              harvest.stop?.()
              closeBuf()
              segHarvesting = false
              dbg('harvest off for segment (frame drops)', { fallbacks })
            } else if (!document.hidden) {
              try {
                await v.play() // resume the harvest for the next frames
              } catch {
                segHarvesting = false
              }
            }
          }
        }
        worker.postMessage(
          { type: 'frame', n, frame, fit: fitFor(seg, v.videoWidth || W, v.videoHeight || H, t), ovs },
          [frame as unknown as Transferable, ...ovT]
        )
      }
      // backpressure: never let the encoder queue run away
      if (lastQueue > 8) await new Promise<void>((res) => (ackResolve = res))
      if (n % 15 === 0) onProgress(5 + Math.round((n / totalFrames) * 90), exportMsg(n / totalFrames))
    }
    dbg('frames done', `${Math.round(performance.now() - tExport0)}ms for ${totalFrames} frames (${rvfcOK ? 'play-harvest' : 'seek'})`)
    worker.postMessage({ type: 'finish' })
    onProgress(96, 'Polishing video…')
    const buffer = await done
    const name = `${(project.name || 'export').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[^.]+$/, '')}-ondevice.mp4`
    return { blob: new Blob([buffer], { type: 'video/mp4' }), name }
  } catch (e) {
    dbg('FAILED', (e as Error).message)
    throw e
  } finally {
    harvest.stop?.()
    closeBuf()
    for (const v of [...pool.values(), ...ovVideos.map((o) => o.v)]) {
      try {
        v.pause()
      } catch {
        /* already gone */
      }
      v.removeAttribute('src')
      v.load()
      v.remove()
    }
    setTimeout(() => worker.terminate(), 1000)
  }
}
