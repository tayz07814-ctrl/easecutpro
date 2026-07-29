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
// output frame N is sourced at time N/FPS by SEEKING each source (index math,
// never the wall clock), so a slow device only makes the export take longer; it
// can't change the file's duration or frame count.
//
// Compositing mirrors the encoder worker (base contain-fit + eased Ken Burns,
// overlay boxes with crop + Ken Burns, baked text on top, z-ordering). This path
// is used ONLY when probeEncodeCaps().audio === false; every other browser keeps
// the untouched mp4-muxer exporter. Uses a plain per-frame seek (no play-harvest)
// — simpler and correct; iOS devices that lack native AAC are still fast enough.

import { getSharedEngine } from '../timelineEngine'
import { kenBurnsEase } from '../kenBurns'
import { planFromDoc, renderAudio, seamFadeSeconds, FPS, exportMsg, type Seg } from './localExport'
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

  // Mediabunny + the AAC polyfill are code-split — only an iOS<26 export loads them.
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, canEncodeAudio } =
    await import('mediabunny')
  if (!(await canEncodeAudio('aac'))) {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder')
    registerAacEncoder() // WASM AAC; Mediabunny now uses it wherever native AAC is missing
    dbg('registered WASM AAC encoder (native AudioEncoder unavailable)')
  }

  // Offline audio mix — same honest-failure semantics as the native path
  // (renderAudio throws if a source that should contribute sound can't decode).
  const audioBuf = await renderAudio(segs, audio, total, (p) => onProgress(p, 'Mixing your audio…'), seamFadeSeconds())

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('no 2d canvas in this browser')
  // Highest-quality resampling for the Ken Burns scale — bilinear/'low' shimmers
  // and aliases on a slow zoom; 'high' glides. (Float dst coords keep it subpixel.)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: Math.round(opts.bitrateMbps * 1_000_000),
    keyFrameInterval: 2 // matches the native path's every-2s key frame
  })
  output.addVideoTrack(videoSource, { frameRate: FPS })
  const audioSource = audioBuf ? new AudioBufferSource({ codec: 'aac', bitrate: 192_000 }) : null
  if (audioSource) output.addAudioTrack(audioSource)

  // ---- compositing (twin of encoderWorker.ts paint/draw — keep in lockstep) ----
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

  // ---- source pools ----
  const openVideo = async (url: string): Promise<HTMLVideoElement> => {
    const v = document.createElement('video')
    v.src = url
    v.muted = true
    v.preload = 'auto'
    ;(v as unknown as { playsInline: boolean }).playsInline = true
    v.style.display = 'none'
    document.body.appendChild(v)
    await new Promise<void>((res, rej) => {
      // readyState >= 2 → a decoded frame exists (VideoFrame(video) needs it)
      v.onloadeddata = () => res()
      v.onerror = () => rej(new Error('cannot open a source in this browser'))
      if (v.readyState >= 2) res()
    })
    try {
      // iOS won't decode frames for a never-played muted <video> — prime it.
      await v.play()
      v.pause()
    } catch {
      /* autoplay refused; the seek below may still present a frame */
    }
    return v
  }
  const seekTo = (v: HTMLVideoElement, tt: number): Promise<void> =>
    new Promise((res) => {
      if (Math.abs(v.currentTime - tt) <= 1 / (FPS * 2) && v.readyState >= 2) {
        res()
        return
      }
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(to)
        v.removeEventListener('seeked', on)
        res()
      }
      const on = (): void => finish()
      const to = setTimeout(finish, 2000) // decoder stall: use whatever frame is there
      v.addEventListener('seeked', on)
      try {
        v.currentTime = tt
      } catch {
        finish()
      }
    })

  const sprites: Sprite[] = []
  const mainImages = new Map<string, ImageBitmap>()
  const pool = new Map<string, HTMLVideoElement>()
  const ovVideos: Array<{ spec: OverlayClipSpec; v: HTMLVideoElement; rect: OverlayRect }> = []

  try {
    const overlays = planOverlays(doc)
    const texts = planTexts(doc)
    // image overlays first (z = plan order) …
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
      sprites.push({ bitmap: bmp, z: o.z, start: o.start, end: o.end, rect: overlayRect(W, H, o), clip: true, zoom })
    }
    // … then baked text, stacked ABOVE every overlay (preview order: TextLayer
    // renders after OverlayLayer) via a large z offset.
    let ti = 0
    for (const tc of texts) {
      const bmp = await bakeTextBitmap(tc, W, H)
      sprites.push({ bitmap: bmp, z: 1e6 + ti, start: tc.start, end: tc.end, rect: fullFrameRect(W, H), clip: false, zoom: null })
      ti++
    }
    // main-lane image clips: decode once per unique source
    for (const url of new Set(segs.filter((s) => s.isImage).map((s) => s.url))) {
      try {
        mainImages.set(url, await loadImageBitmap(url))
      } catch {
        throw new Error('cannot open an image in this browser')
      }
    }
    // one hidden <video> per unique main source, one per video OVERLAY clip
    for (const url of new Set(segs.filter((s) => !s.isImage).map((s) => s.url))) pool.set(url, await openVideo(url))
    for (const o of overlays) {
      if (o.isImage) continue
      ovVideos.push({ spec: o, v: await openVideo(o.url), rect: overlayRect(W, H, o) })
    }
    dbg('pool ready', { sprites: sprites.length, images: mainImages.size, videoOverlays: ovVideos.length })

    await output.start()
    if (audioSource && audioBuf) {
      await audioSource.add(audioBuf) // encodes the whole track (fast); muxed by timestamp
      dbg('audio added', audioBuf.duration.toFixed(2) + 's')
    }

    const tExport0 = performance.now()
    for (let n = 0; n < totalFrames; n++) {
      const t = (n + 0.0001) / FPS
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)

      // base (main lane): image asset, seeked video frame, or a black gap
      const seg = segs.find((s) => t >= s.start && t < s.start + s.len)
      if (seg && seg.isImage) {
        const bmp = mainImages.get(seg.url)
        if (bmp) drawBase(bmp, fitFor(seg, bmp.width || W, bmp.height || H, t))
      } else if (seg) {
        const v = pool.get(seg.url)!
        const want = Math.min(seg.sourceEnd - 0.001, seg.sourceStart + (t - seg.start) * seg.speed)
        await seekTo(v, want)
        try {
          const frame = new VideoFrame(v, { timestamp: 0 })
          drawBase(frame, fitFor(seg, v.videoWidth || W, v.videoHeight || H, t))
          frame.close()
        } catch {
          /* not decodable this tick — leave the gap black for one frame */
        }
      }

      // overlays + text, z-ordered above the base (main < overlays < text)
      const draws: Array<{ z: number; run: () => void }> = []
      for (const s of sprites) {
        if (t < s.start || t >= s.end) continue
        const zm = s.zoom
        const zoom = zm ? zm.zs + (zm.ze - zm.zs) * kenBurnsEase(zm.len > 0 ? (t - zm.start) / zm.len : 1) : 1
        draws.push({ z: s.z, run: () => paint(s.bitmap, s.rect, s.clip, zoom) })
      }
      const ovFrames: VideoFrame[] = []
      for (const o of ovVideos) {
        const sp = o.spec
        if (t < sp.start || t >= sp.end) continue
        const owant = Math.min(sp.sourceIn + sp.rampLen - 0.001, sp.sourceIn + (t - sp.start))
        await seekTo(o.v, owant)
        let ovf: VideoFrame
        try {
          ovf = new VideoFrame(o.v, { timestamp: 0 })
        } catch {
          continue // decoder hiccup — drop this overlay for one frame, not the export
        }
        ovFrames.push(ovf)
        const scale = sp.zs + (sp.ze - sp.zs) * kenBurnsEase((t - sp.start) / sp.rampLen)
        draws.push({ z: sp.z, run: () => paint(ovf, o.rect, true, scale) })
      }
      draws.sort((a, b) => a.z - b.z)
      for (const d of draws) d.run()
      for (const ovf of ovFrames) ovf.close()

      // await = encoder/writer backpressure (never runs the queue away)
      await videoSource.add(n / FPS, 1 / FPS)
      if (n % 15 === 0)
        onProgress(5 + Math.round((n / totalFrames) * 90), exportMsg(n / totalFrames))
    }
    dbg('frames done', `${Math.round(performance.now() - tExport0)}ms for ${totalFrames} frames`)

    onProgress(96, 'Polishing video…')
    await output.finalize()
    const buffer = output.target.buffer
    if (!buffer) throw new Error('export produced no data')
    const name = `${(project.name || 'export').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[^.]+$/, '')}-ondevice.mp4`
    dbg('done', buffer.byteLength)
    return { blob: new Blob([buffer], { type: 'video/mp4' }), name }
  } catch (e) {
    dbg('FAILED', (e as Error).message)
    try {
      if (output.state === 'pending' || output.state === 'started') await output.cancel()
    } catch {
      /* already torn down */
    }
    throw e
  } finally {
    for (const s of sprites) s.bitmap.close()
    for (const b of mainImages.values()) b.close()
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
  }
}
