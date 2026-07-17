// On-device export — encoder worker.
//
// OFFLINE pipeline: every frame arrives with a timestamp computed from its
// INDEX (n / fps), never from the wall clock, so device hitches can only make
// the export take longer — they can never appear inside the file as freezes,
// drops or stretched duration (the failure mode of realtime captureStream/
// MediaRecorder exports). Compositing (contain-fit + eased Ken Burns on the
// main lane, overlay boxes + baked text sprites above it — geometry from
// export/overlays.ts, the preview's math) happens here on an OffscreenCanvas
// so the page never stutters; VideoEncoder / AudioEncoder are hardware-backed
// where available; mp4-muxer writes the file in memory and hands back one
// ArrayBuffer.
//
// Backpressure: after each frame the worker acks with its encode queue depth;
// the main thread pauses feeding when the queue runs deep.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { kenBurnsEase } from '../kenBurns'
import type { OverlayRect, ZoomRamp } from './overlays'

interface InitMsg {
  type: 'init'
  width: number
  height: number
  fps: number
  videoCodec: string // e.g. 'avc1.640028'
  bitrate: number // bits/sec
  audio: { codec: string; sampleRate: number; channels: number; bitrate: number } | null
}
interface FrameMsg {
  type: 'frame'
  n: number
  frame: VideoFrame | null // null = black frame (timeline gap) or an image clip
  /** main-lane IMAGE clip: draw this previously-sent asset as the base. */
  imageId?: number
  /** draw params: contain-fit + Ken Burns (already eased by the sender). */
  fit?: { dx: number; dy: number; dw: number; dh: number; scale: number; ox: number; oy: number }
  /** video-overlay frames harvested for THIS output frame (z-ordered draw). */
  ovs?: Array<{ frame: VideoFrame; z: number; rect: OverlayRect; scale: number }>
}
/** A bitmap composited over a time window — baked text or an image overlay.
 *  Transferred once; frames arrive in order, so the bitmap is closed the first
 *  frame past its window. */
interface SpriteMsg {
  type: 'sprite'
  id: number
  bitmap: ImageBitmap
  z: number
  /** seconds, on the same (n + 0.0001) / fps clock the sender's loop uses. */
  start: number
  end: number
  rect: OverlayRect
  /** clip to the box rect (the preview's overflow-hidden .ov-box); baked text is full-frame. */
  clip: boolean
  zoom: ZoomRamp | null
}
/** A reusable bitmap the frame stream references by id (main-lane image clips). */
interface AssetMsg {
  type: 'asset'
  id: number
  bitmap: ImageBitmap
}
interface AudioMsg {
  type: 'audio'
  data: AudioData
}
interface FinishMsg {
  type: 'finish'
}

let muxer: Muxer<ArrayBufferTarget> | null = null
let videoEncoder: VideoEncoder | null = null
let audioEncoder: AudioEncoder | null = null
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let W = 0
let H = 0
let FPS = 30
let framesSinceKey = 0
let fatal: string | null = null
let sprites: SpriteMsg[] = []
const assets = new Map<number, ImageBitmap>()

function die(err: string): void {
  fatal = err
  ;(self as unknown as Worker).postMessage({ type: 'error', error: err })
}

/** The caps probe negotiates the H.264 PROFILE at 1080p and hands us a level-4.0
 *  codec string (…0028). Level 4.0 tops out at ~2.1 MP (1080p), so a 4K or
 *  portrait-4K timeline (e.g. 2160×3840 = 8.3 MP) overflows it and configure()
 *  throws "exceeds the maximum coded area … for AVC level (4.0)". Keep the
 *  negotiated profile but raise the LEVEL to the lowest the browser actually
 *  accepts at the real width×height×fps×bitrate (4K needs 5.1+). */
async function pickVideoCodec(base: string, w: number, h: number, bitrate: number, fps: number): Promise<string> {
  const m = /^avc1\.([0-9a-fA-F]{4})([0-9a-fA-F]{2})$/.exec(base)
  const prefix = m ? m[1] : '6400' // profile_idc + constraint flags (default High)
  const baseLevel = m ? parseInt(m[2], 16) : 0x28
  // AVC levels 3.1, 3.2, 4.0, 4.1, 4.2, 5.0, 5.1, 5.2, 6.0, 6.1, 6.2 (ascending).
  const LEVELS = [0x1f, 0x20, 0x28, 0x29, 0x2a, 0x32, 0x33, 0x34, 0x3c, 0x3d, 0x3e]
  for (const lvl of LEVELS) {
    if (lvl < baseLevel) continue // never drop below the negotiated level
    const codec = `avc1.${prefix}${lvl.toString(16).padStart(2, '0')}`
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: fps })
      if (s.supported === true) return codec
    } catch {
      /* this level can't hold w×h here — try a higher one */
    }
  }
  return base // nothing matched (unusual) — let configure() surface the real error
}

/** Composite a bitmap/frame into its overlay rect: clip to the box (the
 *  preview's overflow-hidden .ov-box), Ken Burns scale about the inner centre
 *  (transform-origin: center center), source stretched to the inner rect. */
function paint(img: ImageBitmap | VideoFrame, r: OverlayRect, clip: boolean, scale: number): void {
  ctx!.save()
  if (clip) {
    ctx!.beginPath()
    ctx!.rect(r.bx, r.by, r.bw, r.bh)
    ctx!.clip()
  }
  if (Math.abs(scale - 1) > 0.001) {
    const cx = r.ix + r.iw / 2
    const cy = r.iy + r.ih / 2
    ctx!.translate(cx, cy)
    ctx!.scale(scale, scale)
    ctx!.translate(-cx, -cy)
  }
  ctx!.drawImage(img, r.ix, r.iy, r.iw, r.ih)
  ctx!.restore()
}

self.onmessage = async (ev: MessageEvent<InitMsg | FrameMsg | SpriteMsg | AssetMsg | AudioMsg | FinishMsg>) => {
  const msg = ev.data
  try {
    if (msg.type === 'init') {
      W = msg.width
      H = msg.height
      FPS = msg.fps
      muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: W, height: H },
        audio: msg.audio ? { codec: 'aac', sampleRate: msg.audio.sampleRate, numberOfChannels: msg.audio.channels } : undefined,
        fastStart: 'in-memory'
      })
      videoEncoder = new VideoEncoder({
        output: (chunk, meta) => muxer!.addVideoChunk(chunk, meta),
        error: (e) => die(`video encoder: ${e.message}`)
      })
      // Raise the AVC level to fit the real resolution — the probe only picks the
      // profile (at level 4.0), which overflows on 4K/portrait-4K timelines.
      const videoCodec = await pickVideoCodec(msg.videoCodec, W, H, msg.bitrate, FPS)
      videoEncoder.configure({
        codec: videoCodec,
        width: W,
        height: H,
        bitrate: msg.bitrate,
        framerate: FPS
      })
      if (msg.audio) {
        audioEncoder = new AudioEncoder({
          output: (chunk, meta) => muxer!.addAudioChunk(chunk, meta),
          error: (e) => die(`audio encoder: ${e.message}`)
        })
        audioEncoder.configure({
          codec: msg.audio.codec,
          sampleRate: msg.audio.sampleRate,
          numberOfChannels: msg.audio.channels,
          bitrate: msg.audio.bitrate
        })
      }
      canvas = new OffscreenCanvas(W, H)
      ctx = canvas.getContext('2d', { alpha: false })
      if (ctx) {
        // Highest-quality resampling for the Ken Burns scale (kills shimmer /
        // aliasing on slow zooms); float dst coords keep the motion subpixel.
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
      }
      ;(self as unknown as Worker).postMessage({ type: 'ready' })
      return
    }
    if (fatal) return

    if (msg.type === 'sprite') {
      sprites.push(msg)
      return
    }
    if (msg.type === 'asset') {
      assets.set(msg.id, msg.bitmap)
      return
    }

    if (msg.type === 'frame') {
      const ts = Math.round((msg.n * 1e6) / FPS) // µs — INDEX-based, never wall clock
      const dur = Math.round(1e6 / FPS)
      const t = (msg.n + 0.0001) / FPS // sprite windows use the sender's frame clock
      ctx!.fillStyle = '#000'
      ctx!.fillRect(0, 0, W, H)
      const base = msg.frame ?? (msg.imageId !== undefined ? assets.get(msg.imageId) : undefined)
      if (base && msg.fit) {
        const f = msg.fit
        ctx!.save()
        if (Math.abs(f.scale - 1) > 0.001) {
          ctx!.translate(f.ox, f.oy)
          ctx!.scale(f.scale, f.scale)
          ctx!.translate(-f.ox, -f.oy)
        }
        ctx!.drawImage(base, f.dx, f.dy, f.dw, f.dh)
        ctx!.restore()
      }
      msg.frame?.close()
      // Overlays above the base, baked text above overlays (its z is offset
      // high by the sender) — one z-sorted pass merges the resident sprites
      // with this frame's video-overlay grabs, matching the preview stacking
      // (main lane < OverlayLayer < TextLayer).
      const draws: Array<{ z: number; run: () => void }> = []
      for (const s of sprites) {
        if (t < s.start || t >= s.end) continue
        const zm = s.zoom
        const zoom = zm ? zm.zs + (zm.ze - zm.zs) * kenBurnsEase(zm.len > 0 ? (t - zm.start) / zm.len : 1) : 1
        draws.push({ z: s.z, run: () => paint(s.bitmap, s.rect, s.clip, zoom) })
      }
      for (const o of msg.ovs ?? []) draws.push({ z: o.z, run: () => paint(o.frame, o.rect, true, o.scale) })
      draws.sort((a, b) => a.z - b.z)
      for (const d of draws) d.run()
      for (const o of msg.ovs ?? []) o.frame.close()
      // a sprite whose window has passed never draws again — free its pixels now
      if (sprites.some((s) => t >= s.end)) {
        for (const s of sprites) if (t >= s.end) s.bitmap.close()
        sprites = sprites.filter((s) => t < s.end)
      }
      const out = new VideoFrame(canvas!, { timestamp: ts, duration: dur })
      const keyFrame = framesSinceKey === 0 || framesSinceKey >= FPS * 2
      if (keyFrame) framesSinceKey = 0
      framesSinceKey++
      videoEncoder!.encode(out, { keyFrame })
      out.close()
      ;(self as unknown as Worker).postMessage({ type: 'ack', n: msg.n, queue: videoEncoder!.encodeQueueSize })
      return
    }

    if (msg.type === 'audio') {
      audioEncoder?.encode(msg.data)
      msg.data.close()
      return
    }

    if (msg.type === 'finish') {
      for (const s of sprites) s.bitmap.close()
      sprites = []
      for (const b of assets.values()) b.close()
      assets.clear()
      await videoEncoder?.flush()
      await audioEncoder?.flush()
      muxer!.finalize()
      const { buffer } = muxer!.target
      ;(self as unknown as Worker).postMessage({ type: 'done', buffer }, [buffer])
      return
    }
  } catch (e) {
    die(String((e as Error).message ?? e))
  }
}
