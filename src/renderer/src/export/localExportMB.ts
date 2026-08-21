// On-device export — Mediabunny path (iOS/iPadOS Safari < 26).
//
// Safari shipped WebCodecs VIDEO-ONLY before v26, so the normal
// mp4-muxer + WebCodecs exporter (localExport.ts) can't produce the AAC audio
// track there — every iOS browser is WebKit, so this hits Safari AND iOS Chrome.
// This module keeps the sound by muxing with Mediabunny and polyfilling AAC
// through @mediabunny/aac-encoder (a WASM build of FFmpeg's AAC encoder).
// Mediabunny + the WASM encoder are DYNAMICALLY imported, so they add nothing to
// the bundle for the exports that use the native path (Android/desktop/iOS 26+).
//
// It runs on the MAIN thread on purpose: the AAC encoder spawns its OWN worker,
// and nested workers are unreliable on iOS WebKit. Video still hardware-encodes
// through WebCodecs (available on iOS). Correctness mirrors localExport.ts —
// output frame N is sourced at time N/FPS from a monotonic demux + WebCodecs
// decode stream (index math, never the wall clock), so a slow device only makes
// the export take longer; it can't change the file's duration or frame count.
//
// Compositing mirrors the encoder worker (base contain-fit + eased Ken Burns,
// overlay boxes with crop + Ken Burns, baked text on top, z-ordering). This path
// is used ONLY when probeEncodeCaps().audio === false; every other browser keeps
// the mp4-muxer exporter. Video uses the same deterministic sequential decode
// graph here; only AAC/muxing differs.

import { getSharedEngine } from '../timelineEngine'
import { kenBurnsEase } from '../kenBurns'
import { planFromDoc, renderAudio, seamFadeSeconds, FPS, exportMsg, type Seg } from './localExport'
import { openDecodeSource, type DecodeSource } from './decodeSource'
import {
  planOverlays,
  planTexts,
  overlayRect,
  fullFrameRect,
  bakeTextBitmap,
  loadImageBitmap,
  type OverlayClipSpec,
  type OverlayRect
} from './overlays'
import type { Project } from '@shared/types'

const dbg = (...a: unknown[]): void => console.log('[ondevice-mb]', ...a)

interface Fit {
  dx: number
  dy: number
  dw: number
  dh: number
  scale: number
  ox: number
  oy: number
}
interface Sprite {
  bitmap: ImageBitmap
  z: number
  start: number
  end: number
  rect: OverlayRect
  clip: boolean
  zoom: { zs: number; ze: number; start: number; len: number } | null
}

export async function exportOnDeviceMB(
  project: Project,
  opts: { width: number; height: number; bitrateMbps: number },
  onProgress: (pct: number, msg: string) => void
): Promise<{ blob: Blob; name: string }> {
  const doc = getSharedEngine()?.document
  if (!doc) throw new Error('timeline not ready')
  const { segs, audio, total } = planFromDoc(doc, project)
  if (!segs.length || total <= 0) throw new Error('nothing to export')

  const W = Math.max(16, Math.round(opts.width / 2) * 2)
  const H = Math.max(16, Math.round(opts.height / 2) * 2)
  const totalFrames = Math.max(1, Math.round(total * FPS))
  onProgress(1, 'Getting ready to export…')

  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, canEncodeAudio } =
    await import('mediabunny')
  if (!(await canEncodeAudio('aac'))) {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder')
    registerAacEncoder()
    dbg('registered WASM AAC encoder')
  }

  const audioPromise = renderAudio(
    segs,
    audio,
    total,
    (p) => onProgress(p, 'Mixing your audio…'),
    seamFadeSeconds()
  )

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('no 2d canvas in this browser')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: Math.round(opts.bitrateMbps * 1_000_000),
    keyFrameInterval: 2
  })
  output.addVideoTrack(videoSource, { frameRate: FPS })

  const audioBuf = await audioPromise
  const audioSource = audioBuf ? new AudioBufferSource({ codec: 'aac', bitrate: 192_000 }) : null
  if (audioSource) output.addAudioTrack(audioSource)

  const paint = (img: CanvasImageSource, r: OverlayRect, clip: boolean, scale: number): void => {
    ctx.save()
    if (clip) {
      ctx.beginPath()
      if (r.round) ctx.ellipse(r.bx + r.bw / 2, r.by + r.bh / 2, r.bw / 2, r.bh / 2, 0, 0, Math.PI * 2)
      else ctx.rect(r.bx, r.by, r.bw, r.bh)
      ctx.clip()
    }
    if (Math.abs(scale - 1) > 0.001) {
      const cx = r.ix + r.iw / 2
      const cy = r.iy + r.ih / 2
      ctx.translate(cx, cy)
      ctx.scale(scale, scale)
      ctx.translate(-cx, -cy)
    }
    ctx.drawImage(img, r.ix, r.iy, r.iw, r.ih)
    ctx.restore()
  }

  const drawBase = (img: CanvasImageSource, f: Fit): void => {
    ctx.save()
    if (Math.abs(f.scale - 1) > 0.001) {
      ctx.translate(f.ox, f.oy)
      ctx.scale(f.scale, f.scale)
      ctx.translate(-f.ox, -f.oy)
    }
    ctx.drawImage(img, f.dx, f.dy, f.dw, f.dh)
    ctx.restore()
  }

  const fitFor = (seg: Seg, vw: number, vh: number, t: number): Fit => {
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

  const sprites: Sprite[] = []
  const mainImages = new Map<string, ImageBitmap>()
  const decoders = new Map<string, DecodeSource>()
  const ovVideos: Array<{
    spec: OverlayClipSpec
    dec: DecodeSource
    rect: OverlayRect
    iter: AsyncGenerator<VideoFrame | null, void, unknown> | null
  }> = []

  try {
    const overlays = planOverlays(doc)
    const texts = planTexts(doc)

    for (const o of overlays) {
      if (!o.isImage) continue
      const bmp = await loadImageBitmap(o.url)
      const zoom = Math.abs(o.zs - 1) > 0.001 || Math.abs(o.ze - 1) > 0.001
        ? { zs: o.zs, ze: o.ze, start: o.start, len: o.rampLen }
        : null
      sprites.push({ bitmap: bmp, z: o.z, start: o.start, end: o.end, rect: overlayRect(W, H, o), clip: true, zoom })
    }
    let ti = 0
    for (const tc of texts) {
      const bmp = await bakeTextBitmap(tc, W, H)
      sprites.push({ bitmap: bmp, z: 1e6 + ti++, start: tc.start, end: tc.end, rect: fullFrameRect(W, H), clip: false, zoom: null })
    }
    for (const url of new Set(segs.filter((s) => s.isImage).map((s) => s.url))) {
      mainImages.set(url, await loadImageBitmap(url))
    }

    // iOS follows the same deterministic decode graph as desktop: demux the file
    // once, feed monotonically increasing timestamps to VideoDecoder, and never
    // use HTMLVideoElement.currentTime/requestVideoFrameCallback for export.
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

    // Build monotonically increasing timestamp requests once per clip.
    const sortedSegs = [...segs].sort((a, b) => a.start - b.start)
    const segWants = new Map<Seg, number[]>()
    for (const s of sortedSegs) if (!s.isImage) segWants.set(s, [])
    let segCursor = 0
    for (let n = 0; n < totalFrames; n++) {
      const t = (n + 0.0001) / FPS
      while (segCursor < sortedSegs.length && t >= sortedSegs[segCursor].start + sortedSegs[segCursor].len - 1e-9) segCursor++
      const s = sortedSegs[segCursor]
      if (s && t >= s.start && t < s.start + s.len && !s.isImage) {
        segWants.get(s)!.push(Math.min(Math.max(s.sourceStart, s.sourceEnd - 1e-4), s.sourceStart + Math.max(0, t - s.start) * s.speed))
      }
    }

    const segIters = new Map<Seg, AsyncGenerator<VideoFrame | null, void, unknown>>()
    for (const s of sortedSegs) if (!s.isImage) segIters.set(s, decoders.get(s.src)!.framesAt(segWants.get(s) ?? []))

    for (const o of ovVideos) {
      const arr: number[] = []
      const first = Math.max(0, Math.ceil(o.spec.start * FPS))
      const last = Math.min(totalFrames - 1, Math.ceil(o.spec.end * FPS) - 1)
      for (let n = first; n <= last; n++) {
        const t = (n + 0.0001) / FPS
        arr.push(Math.min(o.spec.sourceIn + o.spec.rampLen - 1e-4, o.spec.sourceIn + Math.max(0, t - o.spec.start)))
      }
      o.iter = o.dec.framesAt(arr)
    }

    await output.start()
    if (audioSource && audioBuf) {
      await audioSource.add(audioBuf)
      dbg('audio added', audioBuf.duration.toFixed(2) + 's')
    }

    const tExport0 = performance.now()
    let cursor = 0
    let activeSeg: Seg | null = null
    let activeSegIter: AsyncGenerator<VideoFrame | null, void, unknown> | null = null
    for (let n = 0; n < totalFrames; n++) {
      const t = (n + 0.0001) / FPS
      while (cursor < sortedSegs.length && t >= sortedSegs[cursor].start + sortedSegs[cursor].len - 1e-9) cursor++
      const seg = sortedSegs[cursor]
      if (seg !== activeSeg) {
        if (activeSegIter) void activeSegIter.return(undefined)
        activeSeg = seg ?? null
        activeSegIter = seg ? (segIters.get(seg) ?? null) : null
      }
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)

      if (seg && seg.isImage) {
        const bmp = mainImages.get(seg.url)
        if (!bmp) throw new Error(`image source is unavailable: ${seg.src}`)
        drawBase(bmp, fitFor(seg, bmp.width || W, bmp.height || H, t))
      } else if (seg) {
        const iter = activeSegIter
        const dec = decoders.get(seg.src)
        if (!iter || !dec) throw new Error(`decoder iterator missing for: ${seg.src}`)
        const r = await iter.next()
        const frame = (r.done ? null : r.value) ?? null
        if (!frame) throw new Error(`video decoder returned no frame at ${t.toFixed(3)}s: ${seg.src}`)
        try {
          drawBase(frame, fitFor(seg, dec.width || W, dec.height || H, t))
        } finally {
          frame.close()
        }
      }

      const draws: Array<{ z: number; run: () => void }> = []
      for (const s of sprites) {
        if (t < s.start || t >= s.end) continue
        const zm = s.zoom
        const zoom = zm ? zm.zs + (zm.ze - zm.zs) * kenBurnsEase(zm.len > 0 ? (t - zm.start) / zm.len : 1) : 1
        draws.push({ z: s.z, run: () => paint(s.bitmap, s.rect, s.clip, zoom) })
      }
      const ovFrames: VideoFrame[] = []
      for (const o of ovVideos) {
        if (t < o.spec.start || t >= o.spec.end) continue
        const r = await o.iter!.next()
        const frame = (r.done ? null : r.value) ?? null
        if (!frame) throw new Error(`overlay decoder returned no frame at ${t.toFixed(3)}s: ${o.spec.src}`)
        ovFrames.push(frame)
        const scale = o.spec.zs + (o.spec.ze - o.spec.zs) * kenBurnsEase((t - o.spec.start) / o.spec.rampLen)
        draws.push({ z: o.spec.z, run: () => paint(frame, o.rect, true, scale) })
      }
      draws.sort((a, b) => a.z - b.z)
      try {
        for (const d of draws) d.run()
      } finally {
        for (const frame of ovFrames) frame.close()
      }

      // CanvasSource.add applies its own encoder backpressure. Because source
      // frames are sequential and exact, there is no realtime clock to fight.
      await videoSource.add(n / FPS, 1 / FPS)
      if (n % 15 === 0) onProgress(5 + Math.round((n / totalFrames) * 90), exportMsg(n / totalFrames))
    }

    if (activeSegIter) { void activeSegIter.return(undefined); activeSegIter = null }
    videoSource.close()
    audioSource?.close?.()
    onProgress(96, 'Polishing video…')
    await output.finalize()
    const buffer = output.target.buffer
    if (!buffer) throw new Error('export produced no data')
    const name = `${(project.name || 'export').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[^.]+$/, '')}-ondevice.mp4`
    dbg('done', `${Math.round(performance.now() - tExport0)}ms`, buffer.byteLength)
    return { blob: new Blob([buffer], { type: 'video/mp4' }), name }
  } catch (e) {
    dbg('FAILED', (e as Error)?.message ?? e)
    try {
      if (output.state === 'pending' || output.state === 'started') await output.cancel()
    } catch { /* already torn down */ }
    throw e
  } finally {
    for (const s of sprites) s.bitmap.close()
    for (const b of mainImages.values()) b.close()
    for (const o of ovVideos) {
      try { await o.iter?.return(undefined) } catch { /* done */ }
      o.dec.close()
    }
    for (const d of decoders.values()) d.close()
  }
}
