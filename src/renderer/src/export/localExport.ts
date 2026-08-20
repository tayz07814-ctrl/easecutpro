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
  const audioBuf = await renderAudio(segs, audio, total, (p) => onProgress(p, 'Mixing your audio…'), seamFadeSeconds())
  dbg('renderAudio: done', !!audioBuf)

  // 2) workers — N parallel encoders, main thread muxes
  const NWORKERS = Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1))
  const useMulti = NWORKERS > 1
  const workers: Worker[] = []
  for (let i = 0; i < NWORKERS; i++) {
    workers.push(new Worker(new URL('./encoderWorker.ts', import.meta.url), { type: 'module' }))
  }
  const worker = workers[0] // primary worker (compatibility for error handling)
  const fail = (m: string): void => {
    for (const w of workers) {
      try { w.terminate() } catch { /* gone */ }
    }
    throw new Error(m)
  }

  // Multi-worker: collect encoded chunks in timestamp order and mux on main thread
  let muxer: import('mp4-muxer').Muxer<import('mp4-muxer').ArrayBufferTarget> | null = null
  if (useMulti) {
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer')
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H },
      audio: audioBuf ? { codec: 'aac', sampleRate: AUDIO_RATE, numberOfChannels: 2 } : undefined,
      fastStart: 'in-memory'
    })
  }

  // Audio encoder on main thread (for multi-worker mode)
  let mainAudioEncoder: AudioEncoder | null = null
  if (useMulti && audioBuf) {
    mainAudioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer!.addAudioChunk(chunk, meta),
      error: (e) => fail(`audio encoder: ${e.message}`)
    })
    mainAudioEncoder.configure({ codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 192_000 })
  }

  // Reorder buffer: collect out-of-order chunks and release in timestamp order
  const pendingChunks = new Map<number, { chunk: EncodedVideoChunk; meta: EncodedVideoChunkMetadata }>()
  let nextExpectedTs = 0
  let allDone = false

  let ackResolve: (() => void) | null = null
  let lastQueue = 0
  let workerError: string | null = null
  let readyResolve: (() => void) | null = null
  const done = new Promise<ArrayBuffer>((resolve, reject) => {
    if (!useMulti) {
      // SINGLE WORKER: worker muxes itself and sends {type:'done', buffer}
      const orig = workers[0].onmessage
      workers[0].onmessage = (ev: MessageEvent) => {
        const m = ev.data
        if (m.type === 'ready') { readyResolve?.(); if (orig) (orig as (e: MessageEvent) => void)(ev); return }
        if (m.type === 'ack') { lastQueue = m.queue; ackResolve?.(); ackResolve = null; return }
        if (m.type === 'done') { if (m.buffer) resolve(m.buffer); else if (orig) (orig as (e: MessageEvent) => void)(ev); return }
        if (m.type === 'error') { workerError = m.error; reject(new Error(m.error)); return }
        if (orig) (orig as (e: MessageEvent) => void)(ev)
      }
      workers[0].onerror = (e) => reject(new Error(e.message))
    } else {
      // MULTI WORKER: main thread collects encoded chunks and muxes
      let readyCount = 0
      let doneCount = 0
      const onMsg = (ev: MessageEvent) => {
        const m = ev.data
        if (m.type === 'ready') {
          if (++readyCount === workers.length) readyResolve?.()
        } else if (m.type === 'ack') {
          lastQueue = m.queue
          ackResolve?.()
          ackResolve = null
        } else if (m.type === 'vchunk') {
          pendingChunks.set(m.ts, { chunk: m.chunk, meta: m.meta })
          while (pendingChunks.has(nextExpectedTs)) {
            const { chunk, meta } = pendingChunks.get(nextExpectedTs)!
            pendingChunks.delete(nextExpectedTs)
            if (muxer) muxer.addVideoChunk(chunk, meta ?? undefined)
            nextExpectedTs += Math.round(1e6 / FPS)
          }
        } else if (m.type === 'done') {
          if (++doneCount === workers.length) {
            if (muxer) {
              muxer.finalize()
              resolve(muxer.target.buffer)
            }
          }
        } else if (m.type === 'error') {
          workerError = m.error
          reject(new Error(m.error))
        }
      }
      for (const w of workers) {
        w.onmessage = onMsg
        w.onerror = (e) => reject(new Error(e.message))
      }
    }
  })

  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve
  })

  // Init all workers
  for (let i = 0; i < workers.length; i++) {
    workers[i].postMessage({
      type: 'init',
      width: W,
      height: H,
      fps: FPS,
      videoCodec: caps.videoCodec,
      bitrate: Math.round(opts.bitrateMbps * 1_000_000),
      audio: !useMulti && audioBuf ? { codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, channels: 2, bitrate: 192_000 } : null,
      nomux: useMulti
    })
  }
  dbg('worker init sent', { workers: workers.length, multi: useMulti })
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
      if (useMulti && mainAudioEncoder) {
        mainAudioEncoder.encode(data)
        data.close()
      } else {
        worker.postMessage({ type: 'audio', data }, [data as unknown as Transferable])
      }
    }
  }

  dbg('audio streamed')
  // Flush the main-thread audio encoder so all AAC leaves before video finalizes
  if (useMulti && mainAudioEncoder) void mainAudioEncoder.flush()
  // 4) compositing plan + source pools. Baked bitmaps (text, image overlays,
  //    main-lane images) are TRANSFERRED to the worker once and drawn there on
  //    every frame of their window; the worker closes each when its window
  //    ends. Video overlays keep a hidden element here and ship one VideoFrame
  //    per output frame instead. (Pools fill inside the try so a source that
  //    refuses to open still tears everything down.)
  const texts = planTexts(doc)
  const overlays = planOverlays(doc)
  const ovVideos: Array<{
    spec: OverlayClipSpec
    /** null once this overlay decodes through WebCodecs instead of an element. */
    v: HTMLVideoElement | null
    rect: OverlayRect
    dec: DecodeSource | null
    iter: AsyncGenerator<VideoFrame | null, void, unknown> | null
  }> = []
  const mainImages = new Map<string, { id: number; w: number; h: number }>()
  const pool = new Map<string, HTMLVideoElement>()
  /** Demuxed WebCodecs sources by url; a null entry = this one needs an element. */
  const decoders = new Map<string, DecodeSource | null>()
  /** Main-lane frame pull for the segment being written. */
  let segIter: AsyncGenerator<VideoFrame | null, void, unknown> | null = null
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
  const seekTo = (v: HTMLVideoElement, t: number): Promise<void> => seekPresented(v, t, FPS)

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
  let fallbacks = 0 // per-segment; too many → step the rate down, then pure seek
  let segHarvesting = false
  // HARVEST RATE. Segments used to stream at exactly the clip's own speed, so a
  // 10-minute timeline spent 10 minutes of wall clock just playing the source
  // past the capture — the export was pinned to realtime no matter how fast the
  // machine could decode. Nothing requires that: `want` is derived from the
  // OUTPUT frame index, so playbackRate only controls how fast frames arrive,
  // never which frame a given output lands on. The harvest is already
  // self-regulating (it pauses once it runs 0.5 s ahead of the consumer and the
  // buffer holds 5 frames), so running it fast just moves the bottleneck to the
  // encoder, where it belongs. Elements are muted, so browsers allow the rate.
  // Devices that can't keep up DROP presented frames, so step down a gear at a
  // time — a slow machine ends up back at realtime instead of thrashing between
  // a too-fast harvest and per-frame seeking. The ladder persists across
  // segments: a device that struggled once will struggle again.
  const HARVEST_RATES = [8, 4, 2, 1]
  let rateIdx = 0
  const harvestRate = (speed: number): number => Math.min(16, Math.max(0.25, speed * HARVEST_RATES[rateIdx]))
  // Lookahead depth. Held VideoFrames are full uncompressed surfaces (~3 MB at
  // 1080p, ~12 MB at 4K), so the window shrinks as the frame gets bigger — and
  // the buffer always holds MORE frames than the lookahead can produce, or the
  // safety valve would start evicting frames that are still wanted.
  const MAX_BUF = W * H > 2_500_000 ? 16 : 40
  const LOOKAHEAD_S = (MAX_BUF * 0.6) / FPS
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
      // Evict by TIME, not by count. A fixed 5-deep buffer was fine only while
      // the harvest ran at 1x and the consumer kept pace with it; the moment the
      // harvest is allowed to run ahead, a count cap throws away frames the
      // consumer has NOT reached yet — every one of those becomes a seek, which
      // is exactly the cost the harvest exists to avoid. Frames behind the
      // consumer are dead; frames ahead of it are the whole point of a lookahead.
      while (buf.length && buf[0].t < lastWant - grabTolerance()) buf.shift()!.frame.close()
      while (buf.length > MAX_BUF) buf.shift()!.frame.close() // safety valve
      // Don't decode ahead of consumption (the encoder may be the slow side);
      // the consumer resumes playback when it needs more.
      if (meta.mediaTime > lastWant + LOOKAHEAD_S) {
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
      scale: seg.size * (seg.zs + (seg.ze - seg.zs) * kenBurnsEase(prog)),
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
      // Send sprite to all workers (each needs its own copy for multi-worker)
      for (const w of workers) {
        const c = await createImageBitmap(bmp)
        w.postMessage(
          { type: 'sprite', id: spriteId, bitmap: c, z: o.z, start: o.start, end: o.end, rect: overlayRect(W, H, o), clip: true, zoom },
          [c]
        )
      }
      spriteId++
      bmp.close()
    }
    // … then text bakes, stacked ABOVE every overlay (preview order: TextLayer
    // renders after OverlayLayer) via a large z offset.
    for (const tc of texts) {
      const bmp = await bakeTextBitmap(tc, W, H)
      for (const w of workers) {
        const c = await createImageBitmap(bmp)
        w.postMessage(
          { type: 'sprite', id: spriteId, bitmap: c, z: 1e6 + spriteId, start: tc.start, end: tc.end, rect: fullFrameRect(W, H), clip: false, zoom: null },
          [c]
        )
      }
      spriteId++
      bmp.close()
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
      for (const w of workers) {
        const c = await createImageBitmap(bmp)
        w.postMessage({ type: 'asset', id: rec.id, bitmap: c }, [c])
      }
      bmp.close()
    }
    // Decoders first: a demuxed WebCodecs source runs as fast as the machine
    // can decode, so we only fall back to a hidden <video> (realtime playback or
    // seek-per-frame) for sources Mediabunny can't open or the browser can't
    // decode. One <video> per unique main-lane source; one per VIDEO overlay
    // CLIP (an overlay can reuse a main source at a different time, so overlay
    // elements are never shared by URL).
    for (const s of segs) {
      if (s.isImage || decoders.has(s.url)) continue
      decoders.set(s.url, await openDecodeSource(s.src, s.url))
    }
    for (const url of new Set(segs.filter((s) => !s.isImage).map((s) => s.url))) {
      if (!decoders.get(url)) pool.set(url, await openVideo(url))
    }
    for (const o of overlays) {
      if (o.isImage) continue
      // Each overlay clip opens its OWN decode source, never the main lane's
      // entry for the same file: an overlay that reuses a base source would
      // otherwise run its iterator concurrently with the main lane's off a
      // single sink, and they'd fight over one decoder.
      const dec = await openDecodeSource(o.src, o.url)
      ovVideos.push({ spec: o, v: dec ? null : await openVideo(o.url), rect: overlayRect(W, H, o), dec, iter: null })
    }
    dbg('decode sources', {
      demuxed: [...decoders.values()].filter(Boolean).length + ovVideos.filter((o) => o.dec).length,
      elements: pool.size + ovVideos.filter((o) => o.v).length
    })

    // Source timestamps for every output frame, per segment / per overlay clip.
    // `samplesAtTimestamps` walks the packets ONCE for a monotonic list, so the
    // whole segment costs one decode pass instead of a seek (or a realtime play)
    // per frame. These MUST be generated by the same formula the frame loop
    // uses below, or the pulled frame would drift out of step with its output.
    const segWants = new Map<Seg, number[]>()
    for (const s of segs) segWants.set(s, [])
    const ovWants = new Map<OverlayClipSpec, number[]>()
    for (const o of ovVideos) ovWants.set(o.spec, [])
    for (let n = 0; n < totalFrames; n++) {
      const t = (n + 0.0001) / FPS
      const s = segs.find((x) => t >= x.start && t < x.start + x.len)
      if (s && !s.isImage) segWants.get(s)!.push(Math.min(s.sourceEnd - 0.001, s.sourceStart + (t - s.start) * s.speed))
      for (const o of ovVideos) {
        const sp = o.spec
        if (t < sp.start || t >= sp.end) continue
        ovWants.get(sp)!.push(Math.min(sp.sourceIn + sp.rampLen - 0.001, sp.sourceIn + (t - sp.start)))
      }
    }
    dbg('pool ready', { sprites: spriteId, images: mainImages.size, videoOverlays: ovVideos.length })
    // Round-robin: distribute frames across workers (multi-worker) so compositing+encoding parallelizes
    const targetWorker = (n0: number): Worker => (useMulti ? workers[n0 % workers.length] : worker)
    for (let n = 0; n < totalFrames; n++) {
      if (workerError) fail(workerError)
      const tw = targetWorker(n)
      const t = (n + 0.0001) / FPS
      // video-overlay harvests for THIS output frame — plain per-frame seek
      // (b-roll windows are short; the main lane's play-harvest speed machinery
      // isn't worth its complexity here, and exactness is identical).
      const ovs: Array<{ frame: VideoFrame; z: number; rect: OverlayRect; scale: number }> = []
      for (const o of ovVideos) {
        const sp = o.spec
        if (t < sp.start || t >= sp.end) continue
        const owant = Math.min(sp.sourceIn + sp.rampLen - 0.001, sp.sourceIn + (t - sp.start))
        let ovFrame: VideoFrame | null = null
        if (o.dec) {
          // One decode pass across the whole b-roll window. The element path
          // seeked once per OUTPUT frame here — the single most expensive thing
          // in an export with overlays, at tens of ms each.
          o.iter ??= o.dec.framesAt(ovWants.get(sp) ?? [])
          const r = await o.iter.next()
          ovFrame = (r.done ? null : r.value) ?? null
          if (!ovFrame) continue
        } else if (o.v) {
          if (Math.abs(o.v.currentTime - owant) > 1 / (FPS * 2)) await seekTo(o.v, owant)
          if (o.v.readyState < 2) {
            await new Promise<void>((res) => {
              const to = setTimeout(res, 2000)
              o.v!.onloadeddata = () => {
                clearTimeout(to)
                res()
              }
            })
          }
        } else {
          continue
        }
        try {
          ovs.push({
            frame: ovFrame ?? new VideoFrame(o.v!, { timestamp: 0 }),
            z: sp.z,
            rect: o.rect,
            // eased Ken Burns for this frame (preview twin: OverlayBox zoomFromProg)
            scale: sp.zs + (sp.ze - sp.zs) * kenBurnsEase((t - sp.start) / sp.rampLen)
          })
        } catch {
          /* decoder hiccup — drop this overlay for one frame, not the export */
        }
      }
      const ovT = ovs.map((g) => g.frame as unknown as Transferable)
      const seg = segs.find((s) => t >= s.start && t < s.start + s.len)
      if (!seg) {
        tw.postMessage({ type: 'frame', n, frame: null, ovs }, ovT)
      } else if (seg.isImage) {
        // main-lane image: the decoded asset stands in for the video frame —
        // no harvest machinery, the worker draws it by id with the same fit.
        if (seg !== curSeg) {
          harvest.stop?.()
          closeBuf()
          void segIter?.return(undefined)
          segIter = null
          curSeg = seg
          segHarvesting = false
        }
        const a = mainImages.get(seg.url)!
        tw.postMessage(
          { type: 'frame', n, frame: null, imageId: a.id, fit: fitFor(seg, a.w || W, a.h || H, t), ovs },
          ovT
        )
      } else if (decoders.get(seg.url)) {
        // DEMUXED PATH: one decode pass per segment, running as fast as the
        // machine can decode. No seeking, no realtime playback, and no dropped
        // -frame tolerance check — `samplesAtTimestamps` returns the frame for
        // each requested source time by construction.
        const dec = decoders.get(seg.url)!
        if (seg !== curSeg) {
          harvest.stop?.()
          closeBuf()
          void segIter?.return(undefined)
          curSeg = seg
          segHarvesting = false
          segIter = dec.framesAt(segWants.get(seg) ?? [])
        }
        let frame: VideoFrame | null = null
        if (segIter) {
          const r = await segIter.next()
          frame = (r.done ? null : r.value) ?? null
        }
        const fit = fitFor(seg, dec.width || W, dec.height || H, t)
        if (frame) {
          tw.postMessage({ type: 'frame', n, frame, fit, ovs }, [frame as unknown as Transferable, ...ovT])
        } else {
          // Only happens for a timestamp before the track's first frame; leave
          // the base black for that frame rather than failing the export.
          tw.postMessage({ type: 'frame', n, frame: null, ovs }, ovT)
        }
      } else {
        const v = pool.get(seg.url)!
        const want = Math.min(seg.sourceEnd - 0.001, seg.sourceStart + (t - seg.start) * seg.speed)
        lastWant = want
        if (seg !== curSeg) {
          // Segment switch: the ONE seek, then play-harvest from here.
          harvest.stop?.()
          closeBuf()
          void segIter?.return(undefined)
          segIter = null
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
              v.playbackRate = harvestRate(seg.speed)
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
            // Dropping this often means the harvest is outrunning the device.
            // Drop a gear first — only a device that still can't keep up at 1x
            // gains nothing from the harvest, and THAT one falls back to seeking
            // for the rest of the segment.
            if (++fallbacks > 10) {
              if (rateIdx < HARVEST_RATES.length - 1) {
                rateIdx++
                fallbacks = 0
                try {
                  v.playbackRate = harvestRate(seg.speed)
                } catch {
                  /* rate unsupported — the next drop batch retires the harvest */
                }
                dbg('harvest rate down', { rate: HARVEST_RATES[rateIdx] })
                if (!document.hidden) {
                  try {
                    await v.play()
                  } catch {
                    segHarvesting = false
                  }
                }
              } else {
                harvest.stop?.()
                closeBuf()
                segHarvesting = false
                dbg('harvest off for segment (frame drops)', { fallbacks })
              }
            } else if (!document.hidden) {
              try {
                await v.play() // resume the harvest for the next frames
              } catch {
                segHarvesting = false
              }
            }
          }
        }
        tw.postMessage(
          { type: 'frame', n, frame, fit: fitFor(seg, v.videoWidth || W, v.videoHeight || H, t), ovs },
          [frame as unknown as Transferable, ...ovT]
        )
      }
      // backpressure: never let the encoder queue run away
      if (lastQueue > 20) await new Promise<void>((res) => (ackResolve = res))
      if (n % 15 === 0) onProgress(5 + Math.round((n / totalFrames) * 90), exportMsg(n / totalFrames))
    }
    dbg('frames done', `${Math.round(performance.now() - tExport0)}ms for ${totalFrames} frames (${rvfcOK ? 'play-harvest' : 'seek'})`)
    for (const w of workers) w.postMessage({ type: 'finish' })
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
    // Abandoning a decode iterator mid-segment has to run its finally block, or
    // the sample it is holding never gets released.
    void segIter?.return(undefined)
    for (const o of ovVideos) {
      void o.iter?.return(undefined)
      o.dec?.close()
    }
    for (const d of decoders.values()) d?.close()
    for (const v of [...pool.values(), ...ovVideos.map((o) => o.v)]) {
      if (!v) continue
      try {
        v.pause()
      } catch {
        /* already gone */
      }
      v.removeAttribute('src')
      v.load()
      v.remove()
    }
    setTimeout(() => {
      for (const w of workers) {
        try { w.terminate() } catch { /* gone */ }
      }
      mainAudioEncoder?.close()
    }, 1000)
  }
}
