// On-device export — orchestrator (main thread).
//
// Renders the timeline document WITHOUT uploading anything: video sources are
// demuxed and decoded sequentially through Mediabunny/WebCodecs, output frame N
// is always N / fps, and the worker handles compositing + H.264 + MP4 mux.
// Audio is mixed offline through an OfflineAudioContext into AAC. There is no
// realtime playback clock and no per-output-frame HTMLVideoElement seeking.
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
import { useStore } from '../store'
import { mainTrackId, documentDuration } from '@shared/timeline/model'
import { framesToSeconds } from '@shared/timeline/time'
import { resolveMedia } from '../media/resolver'
import { isWebMediaId, getFile, mp4AudioStartOffset, padLeadingSilence } from '../webmedia'
import { IS_WEB } from '../platform'
import { kenBurnsEase, cropToKenBurns } from '../kenBurns'
import { openDecodeSource, type DecodeSource } from './decodeSource'
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

type VideoRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
}

/** Seek, and wait until the frame is actually PRESENTED — not merely decoded.
 *
 *  `seeked` fires when the decoder finishes the seek. It does NOT promise the new
 *  frame has reached the compositor, and `new VideoFrame(v)` captures whatever is
 *  currently presented. Inside a segment the stale frame is the neighbouring one,
 *  so nobody notices — but at a CUT SEAM the previously presented frame comes from
 *  a completely different part of the source, which bakes exactly one stray frame
 *  into every join.
 *
 *  requestVideoFrameCallback only runs once a frame is available to draw, so it is
 *  the real signal. It is armed BEFORE the seek because it delivers the NEXT
 *  presented frame: arming it afterwards would wait on a presentation that never
 *  comes for a paused element. `seeked` then starts a short backstop in case the
 *  callback never arrives, and a long one covers a wedged decoder. */
export function seekPresented(v: HTMLVideoElement, t: number, fps: number): Promise<void> {
  return new Promise((res) => {
    if (Math.abs(v.currentTime - t) <= 1 / (fps * 2) && v.readyState >= 2) {
      res()
      return
    }
    let done = false
    let backstop: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(stall)
      if (backstop) clearTimeout(backstop)
      v.removeEventListener('seeked', onSeeked)
      res()
    }
    const rvfc = (v as VideoRVFC).requestVideoFrameCallback
    const stall = setTimeout(finish, 2000) // wedged decoder: draw whatever is there
    const onSeeked = (): void => {
      if (typeof rvfc !== 'function') finish()
      else if (!backstop) backstop = setTimeout(finish, 250) // rVFC never arrived
    }
    v.addEventListener('seeked', onSeeked)
    if (typeof rvfc === 'function') rvfc.call(v, () => finish())
    try {
      v.currentTime = t
    } catch {
      finish()
    }
  })
}
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
    // Base-clip crop → cover-zoom + focal pan folded into the Ken Burns size/focal
    // this exporter (and the preview) already apply, so the base video crops in the
    // exported file too. Shared by BOTH exporters via planFromDoc.
    const cbc = cropToKenBurns(c.crop)
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
      size: num(c.metadata?.ovScale, 1) * cbc.scale,
      zs: num(c.metadata?.ovZoomStart, 1),
      ze: num(c.metadata?.ovZoomEnd, 1),
      ox: num(c.metadata?.ovX, 0) + cbc.ovX,
      oy: num(c.metadata?.ovY, 0) + cbc.ovY
    })
  }
  // Runtime spans EVERY lane, not just the main one. An overlay (or a text or
  // music clip) that runs past the last base clip used to be silently truncated
  // here, because `total` drove both the frame count and the audio mix.
  const total = framesToSeconds(documentDuration(doc), tb)

  const audio: AudioClipSched[] = []
  for (const t of doc.tracks) {
    if (t.hidden || t.muted) continue
    // Audio lanes (music / detached voice) AND overlay video lanes: a video moved
    // off the main lane keeps its sound, so it has to reach the mix too — the
    // preview already plays it, only the export was dropping it.
    const isOverlayVideo = t.kind === 'video' && !t.isMain && t.id !== main?.id
    if (t.kind !== 'audio' && !isOverlayVideo) continue
    for (const c of t.clips) {
      if (!c.sourcePath) continue
      if (isOverlayVideo && (c.kind === 'image' || c.muted === true || c.audioDetached === true || c.hasAudio === false)) continue
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

// De-click fade at cut seams. The creator asked for a SINGLE, very subtle fade —
// only at the START of the clip that follows a cut, NEVER on the outgoing tail. A
// two-sided crossfade (the old approach) attenuates the last word of the outgoing
// clip AND the first word of the incoming one, so across many retake cuts it audibly
// eats words. So: no fade-out, no overlap, no removed audio replayed — each kept
// segment plays EXACTLY its body at full gain, and any segment that begins at a real
// cut gets a ~25ms 0→gain ramp that kills the splice click without touching speech.
// Splits (seamless same-source joins) are already continuous and get nothing.
const SEAM_FADE_IN_S = 0.025 // 25ms fade-in at each post-cut clip start (default)

/** The creator-configured seam blend ("overlap") length in seconds — 0 when they
 *  turned overlap off (hard cuts). Read live from the store; falls back to the
 *  default if unavailable. Shared by exportOnDevice AND the Mediabunny path. */
export function seamFadeSeconds(): number {
  try {
    const sf = useStore.getState().seamFade
    return sf?.enabled ? Math.max(0, (sf.ms ?? 25) / 1000) : 0
  } catch {
    return SEAM_FADE_IN_S
  }
}

/** cos/sin ramp of `n` points scaled to `base`: 'in' = 0→base (sin), 'out' =
 *  base→0 (cos). Only 'in' is used now (the subtle post-cut fade-in). */
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
  onProgress: (p: number) => void,
  seamFadeS = SEAM_FADE_IN_S
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
      // Recover the container's audio start offset BEFORE decoding — decodeAudioData
      // both strips the offset AND detaches `ab`, so parse first, then re-pad the
      // decoded buffer so the export audio lines up with the video (see
      // padLeadingSilence). Non-MP4 / clean audio parse to 0 and are untouched.
      const leadSec = mp4AudioStartOffset(ab)
      buf = await decodeCtx().decodeAudioData(ab)
      if (buf && leadSec > 0.001) buf = padLeadingSilence(off, buf, leadSec)
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

  // A segment "starts at a cut" when it is NOT a seamless same-source continuation
  // of the previous audible segment (a split). Those — plus the very first segment
  // (a clean start from silence) — get the short fade-in; contiguous splits play
  // straight through untouched.
  const contiguous = (a: Seg, b: Seg): boolean =>
    a.src === b.src && Math.abs(a.sourceEnd - b.sourceStart) < 0.003 && Math.abs(a.speed - b.speed) < 1e-3
  const fadeInAt = audible.map((cur, i) => (i === 0 ? true : !contiguous(audible[i - 1].s, cur.s)))

  // Schedule each audible segment playing EXACTLY its body at full gain — speech at
  // both edges of every cut is preserved verbatim. At a real cut seam the blend is a
  // TRUE equal-power crossfade: the incoming clip ramps 0→gain (sin) while the
  // OUTGOING clip's audio continues up to `seamFadeS` PAST its cut point, ramping
  // gain→0 (cos) UNDER the incoming words. The tail comes from source audio that the
  // cut removed, capped short (≤60ms) and fading out, so it smooths the join without
  // audibly replaying the removed take. Contiguous splits play straight through.
  for (let i = 0; i < audible.length; i++) {
    const { s, buf } = audible[i]
    const sp = Math.max(0.01, s.speed)
    const base = Math.max(0, s.gain)
    const node = off.createBufferSource()
    node.buffer = buf
    node.playbackRate.value = sp
    const g = off.createGain()
    const fi = seamFadeS > 0 && fadeInAt[i] ? Math.min(seamFadeS, s.len * 0.5) : 0
    if (fi > 0) g.gain.setValueCurveAtTime(equalPowerRamp(base, 'in'), Math.max(0, s.start), fi)
    else g.gain.setValueAtTime(base, Math.max(0, s.start))
    node.connect(g).connect(off.destination)
    // A/V ALIGNMENT (root cause of the seam stutter): the VIDEO occupies the
    // clip's frame-quantized window `s.len` (= framesToSeconds(round((out-in)*fps))),
    // but this audio buffer is `out - in` EXACT source-seconds — off by the sub-frame
    // rounding remainder (0..1/fps). Played as-is it overruns the video window and
    // doubles/flams into the next clip's first samples (or falls short → click) at
    // EVERY cut. Play EXACTLY the video's window instead: fill `s.len` output seconds
    // = `s.len * sp` buffer-seconds, clamped to what the source actually has (never
    // read into the removed footage). Now audio and video share the identical
    // per-clip window, so nothing overruns a seam. A ≤½-frame shortfall (when the
    // frame count rounded UP) lands inside the next clip's fade-in and is inaudible.
    const availLen = s.sourceEnd - s.sourceStart
    const winLen = Math.min(availLen, s.len * sp)
    node.start(Math.max(0, s.start), Math.max(0, s.sourceStart), Math.max(0.01, winLen))

    // Outgoing overlap tail at the NEXT seam (only when the next segment starts at a
    // real cut and the source actually has audio past this clip's cut point). Plays
    // REMOVED source audio (from sourceEnd on) fading cos→0 under the incoming
    // fade-in — independent of the A/V-aligned body window above.
    if (seamFadeS > 0 && i + 1 < audible.length && fadeInAt[i + 1]) {
      const availSrc = Math.max(0, buf.duration - s.sourceEnd) // removed source audio available
      const tail = Math.min(seamFadeS, availSrc / sp)
      if (tail > 0.005) {
        const boundary = Math.max(0, s.start + s.len)
        const tn = off.createBufferSource()
        tn.buffer = buf
        tn.playbackRate.value = sp
        const tg = off.createGain()
        tg.gain.setValueCurveAtTime(equalPowerRamp(base, 'out'), boundary, tail)
        tn.connect(tg).connect(off.destination)
        tn.start(boundary, s.sourceEnd, Math.max(0.005, tail * sp))
      }
    }
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
  if (!caps.audio) {
    const { exportOnDeviceMB } = await import('./localExportMB')
    return exportOnDeviceMB(project, opts, onProgress)
  }

  const { segs, audio, total } = planFromDoc(doc, project)
  if (!segs.length || total <= 0) throw new Error('nothing to export')

  const W = Math.max(16, Math.round(opts.width / 2) * 2)
  const H = Math.max(16, Math.round(opts.height / 2) * 2)
  const totalFrames = Math.max(1, Math.round(total * FPS))
  const frameDur = 1 / FPS

  onProgress(1, 'Getting ready to export…')
  dbg('plan', { segs: segs.length, audio: audio.length, total, W, H, totalFrames })

  // Render audio while the browser is opening/demuxing the video sources. This
  // does not make OfflineAudioContext concurrent with itself, but it removes the
  // old hard serialization between source discovery and audio preparation.
  const audioPromise = renderAudio(
    segs,
    audio,
    total,
    (p) => onProgress(p, 'Mixing your audio…'),
    seamFadeSeconds()
  )

  const worker = new Worker(new URL('./encoderWorker.ts', import.meta.url), { type: 'module' })
  let workerError: string | null = null
  let readyResolve!: () => void
  let readyReject!: (e: Error) => void
  let doneResolve!: (b: ArrayBuffer) => void
  let doneReject!: (e: Error) => void
  const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej })
  const done = new Promise<ArrayBuffer>((res, rej) => { doneResolve = res; doneReject = rej })
  let lastQueue = 0
  const ackWaiters = new Map<number, () => void>()
  const fail = (message: string): void => {
    if (workerError) return
    workerError = message
    const err = new Error(message)
    readyReject(err)
    doneReject(err)
    for (const it of segIters.values()) void it.return(undefined)
    for (const o of ovVideos) void o.iter?.return(undefined)
    for (const d of decoders.values()) d.close()
    try { worker.terminate() } catch { /* gone */ }
  }

  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data
    if (m.type === 'ready') {
      readyResolve()
      return
    }
    if (m.type === 'ack') {
      lastQueue = m.queue
      ackWaiters.get(m.n)?.()
      ackWaiters.delete(m.n)
      return
    }
    if (m.type === 'done') {
      if (m.buffer) doneResolve(m.buffer)
      else doneReject(new Error('export worker returned no buffer'))
      return
    }
    if (m.type === 'error') {
      fail(m.error || 'export worker failed')
    }
  }
  worker.onerror = (e) => fail(e.message || 'export worker crashed')

  try {
    const audioBuf = await audioPromise

    worker.postMessage({
      type: 'init',
      width: W,
      height: H,
      fps: FPS,
      videoCodec: caps.videoCodec,
      bitrate: Math.round(opts.bitrateMbps * 1_000_000),
      audio: audioBuf ? { codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, channels: 2, bitrate: 192_000 } : null,
      nomux: false
    })
    await ready
    if (workerError) throw new Error(workerError)

    // Audio is chunked and sent immediately after worker initialization. The
    // worker encodes it while the main thread prepares the video decode graph.
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

    const texts = planTexts(doc)
    const overlays = planOverlays(doc)
    const mainImages = new Map<string, { id: number; w: number; h: number }>()
    const decoders = new Map<string, DecodeSource>()
    const ovVideos: Array<{
      spec: OverlayClipSpec
      dec: DecodeSource
      rect: OverlayRect
      iter: AsyncGenerator<VideoFrame | null, void, unknown> | null
    }> = []

    // Pre-bake resident sprites once.
    let spriteId = 0
    for (const o of overlays) {
      if (!o.isImage) continue
      const bmp = await loadImageBitmap(o.url)
      try {
        const c = await createImageBitmap(bmp)
        const zoom = Math.abs(o.zs - 1) > 0.001 || Math.abs(o.ze - 1) > 0.001
          ? { zs: o.zs, ze: o.ze, start: o.start, len: o.rampLen }
          : null
        worker.postMessage(
          { type: 'sprite', id: spriteId++, bitmap: c, z: o.z, start: o.start, end: o.end, rect: overlayRect(W, H, o), clip: true, zoom },
          [c]
        )
      } finally {
        bmp.close()
      }
    }
    for (const tc of texts) {
      const bmp = await bakeTextBitmap(tc, W, H)
      try {
        const c = await createImageBitmap(bmp)
        worker.postMessage(
          { type: 'sprite', id: spriteId++, bitmap: c, z: 1e6 + spriteId, start: tc.start, end: tc.end, rect: fullFrameRect(W, H), clip: false, zoom: null },
          [c]
        )
      } finally {
        bmp.close()
      }
    }

    let assetId = 0
    for (const url of new Set(segs.filter((s) => s.isImage).map((s) => s.url))) {
      const bmp = await loadImageBitmap(url)
      try {
        const rec = { id: assetId++, w: bmp.width || W, h: bmp.height || H }
        mainImages.set(url, rec)
        const c = await createImageBitmap(bmp)
        worker.postMessage({ type: 'asset', id: rec.id, bitmap: c }, [c])
      } finally {
        bmp.close()
      }
    }

    // Every video source must use deterministic demux + WebCodecs. There is NO
    // hidden <video> seek/play fallback anymore: a fallback could silently reuse
    // a stale frame and corrupt a cut seam, and it behaves especially badly on
    // Safari/iPhone. A source that cannot be decoded gets an explicit error.
    for (const s of segs) {
      if (s.isImage || decoders.has(s.src)) continue
      const dec = await openDecodeSource(s.src, s.url)
      if (!dec) throw new Error(`video source cannot be decoded by WebCodecs: ${s.src}`)
      decoders.set(s.src, dec)
    }
    for (const o of overlays) {
      if (o.isImage) continue
      const dec = await openDecodeSource(o.src, o.url)
      if (!dec) throw new Error(`overlay video cannot be decoded by WebCodecs: ${o.src}`)
      ovVideos.push({ spec: o, dec, rect: overlayRect(W, H, o), iter: null })
    }

    // Frame wants are generated once with an O(number-of-clips + number-of-frames)
    // cursor instead of a .find() through every clip for every frame.
    const segWants = new Map<Seg, number[]>()
    for (const s of segs) if (!s.isImage) segWants.set(s, [])
    let segCursor = 0
    const sortedSegs = [...segs].sort((a, b) => a.start - b.start)
    for (let n = 0; n < totalFrames; n++) {
      const t = (n + 0.0001) / FPS
      while (segCursor < sortedSegs.length && t >= sortedSegs[segCursor].start + sortedSegs[segCursor].len - 1e-9) segCursor++
      const s = sortedSegs[segCursor]
      if (s && t >= s.start && t < s.start + s.len && !s.isImage) {
        const want = Math.min(Math.max(s.sourceStart, s.sourceEnd - 1e-4), s.sourceStart + Math.max(0, t - s.start) * s.speed)
        segWants.get(s)!.push(want)
      }
    }

    const ovWants = new Map<OverlayClipSpec, number[]>()
    for (const o of ovVideos) ovWants.set(o.spec, [])
    for (const o of ovVideos) {
      const sp = o.spec
      const arr = ovWants.get(sp)!
      const first = Math.max(0, Math.ceil(sp.start * FPS))
      const last = Math.min(totalFrames - 1, Math.ceil(sp.end * FPS) - 1)
      for (let n = first; n <= last; n++) {
        const t = (n + 0.0001) / FPS
        const want = Math.min(sp.sourceIn + Math.max(0, sp.rampLen) - 1e-4, sp.sourceIn + Math.max(0, t - sp.start))
        arr.push(want)
      }
    }

    // Create exactly one iterator per segment/overlay clip. The active timeline
    // order makes each iterator monotonic, and every output frame consumes exactly
    // one element from it. No browser playback clock participates in export.
    const segIters = new Map<Seg, AsyncGenerator<VideoFrame | null, void, unknown>>()
    for (const s of sortedSegs) {
      if (!s.isImage) segIters.set(s, decoders.get(s.src)!.framesAt(segWants.get(s) ?? []))
    }
    for (const o of ovVideos) o.iter = o.dec.framesAt(ovWants.get(o.spec) ?? [])

    const waitForAck = (n: number): Promise<void> => new Promise((resolve) => ackWaiters.set(n, resolve))
    const fitFor = (
      seg: Seg,
      vw: number,
      vh: number,
      t: number
    ): { dx: number; dy: number; dw: number; dh: number; scale: number; ox: number; oy: number } => {
      const s = Math.min(W / Math.max(1, vw), H / Math.max(1, vh))
      const dw = vw * s
      const dh = vh * s
      const prog = seg.len > 0 ? Math.min(1, Math.max(0, (t - seg.start) / seg.len)) : 0
      return {
        dx: (W - dw) / 2,
        dy: (H - dh) / 2,
        dw,
        dh,
        scale: seg.size * (seg.zs + (seg.ze - seg.zs) * kenBurnsEase(prog)),
        ox: W * (0.5 + seg.ox),
        oy: H * (0.5 + seg.oy)
      }
    }

    const tExport0 = performance.now()
    let cursor = 0
    let activeSeg: Seg | null = null
    let activeSegIter: AsyncGenerator<VideoFrame | null, void, unknown> | null = null
    for (let n = 0; n < totalFrames; n++) {
      if (workerError) throw new Error(workerError)
      const t = (n + 0.0001) / FPS
      while (cursor < sortedSegs.length && t >= sortedSegs[cursor].start + sortedSegs[cursor].len - 1e-9) cursor++
      const seg = sortedSegs[cursor]
      if (seg !== activeSeg) {
        if (activeSegIter) void activeSegIter.return(undefined)
        activeSeg = seg ?? null
        activeSegIter = seg ? (segIters.get(seg) ?? null) : null
      }

      const ovs: Array<{ frame: VideoFrame; z: number; rect: OverlayRect; scale: number }> = []
      for (const o of ovVideos) {
        const sp = o.spec
        if (t < sp.start || t >= sp.end) continue
        const r = await o.iter!.next()
        const frame = (r.done ? null : r.value) ?? null
        if (!frame) throw new Error(`overlay decoder returned no frame at ${t.toFixed(3)}s: ${sp.src}`)
        ovs.push({
          frame,
          z: sp.z,
          rect: o.rect,
          scale: sp.zs + (sp.ze - sp.zs) * kenBurnsEase((t - sp.start) / sp.rampLen)
        })
      }
      const ovTransfer = ovs.map((o) => o.frame as unknown as Transferable)

      const ackPromise = waitForAck(n)
      if (!seg) {
        worker.postMessage({ type: 'frame', n, frame: null, ovs }, ovTransfer)
      } else if (seg.isImage) {
        const img = mainImages.get(seg.url)
        if (!img) throw new Error(`image source is unavailable: ${seg.src}`)
        worker.postMessage(
          { type: 'frame', n, frame: null, imageId: img.id, fit: fitFor(seg, img.w, img.h, t), ovs },
          ovTransfer
        )
      } else {
        const iter = activeSegIter
        if (!iter) throw new Error(`decoder iterator missing for: ${seg.src}`)
        const r = await iter.next()
        const frame = (r.done ? null : r.value) ?? null
        if (!frame) throw new Error(`video decoder returned no frame at ${t.toFixed(3)}s: ${seg.src}`)
        worker.postMessage(
          { type: 'frame', n, frame, fit: fitFor(seg, decoders.get(seg.src)!.width, decoders.get(seg.src)!.height, t), ovs },
          [frame as unknown as Transferable, ...ovTransfer]
        )
      }

      // Keep only a very small number of encoded frames in flight. The old 20-
      // frame ceiling could hold hundreds of MB at 4K; 4 is enough to keep the
      // encoder busy without turning export into a memory balloon.
      if (lastQueue >= 4) await ackPromise
      else ackWaiters.delete(n)

      if (n % 15 === 0) onProgress(5 + Math.round((n / totalFrames) * 90), exportMsg(n / totalFrames))
    }

    if (activeSegIter) { void activeSegIter.return(undefined); activeSegIter = null }
    worker.postMessage({ type: 'finish' })
    onProgress(96, 'Polishing video…')
    const buffer = await done
    const name = `${(project.name || 'export').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[^.]+$/, '')}-ondevice.mp4`
    dbg('done', `${Math.round(performance.now() - tExport0)}ms`, buffer.byteLength)
    return { blob: new Blob([buffer], { type: 'video/mp4' }), name }
  } catch (e) {
    dbg('FAILED', (e as Error)?.message ?? e)
    throw e
  } finally {
    for (const it of segIters.values()) void it.return(undefined)
    for (const o of ovVideos) void o.iter?.return(undefined)
    for (const d of decoders.values()) d.close()
    try { worker.terminate() } catch { /* gone */ }
  }
}
