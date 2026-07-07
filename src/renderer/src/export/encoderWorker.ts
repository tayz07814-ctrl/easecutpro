// On-device export — encoder worker.
//
// OFFLINE pipeline: every frame arrives with a timestamp computed from its
// INDEX (n / fps), never from the wall clock, so device hitches can only make
// the export take longer — they can never appear inside the file as freezes,
// drops or stretched duration (the failure mode of realtime captureStream/
// MediaRecorder exports). Compositing (contain-fit + eased Ken Burns) happens
// here on an OffscreenCanvas so the page never stutters; VideoEncoder /
// AudioEncoder are hardware-backed where available; mp4-muxer writes the file
// in memory and hands back one ArrayBuffer.
//
// Backpressure: after each frame the worker acks with its encode queue depth;
// the main thread pauses feeding when the queue runs deep.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

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
  frame: VideoFrame | null // null = black frame (timeline gap)
  /** draw params: contain-fit + Ken Burns (already eased by the sender). */
  fit?: { dx: number; dy: number; dw: number; dh: number; scale: number; ox: number; oy: number }
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

function die(err: string): void {
  fatal = err
  ;(self as unknown as Worker).postMessage({ type: 'error', error: err })
}

self.onmessage = async (ev: MessageEvent<InitMsg | FrameMsg | AudioMsg | FinishMsg>) => {
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
      videoEncoder.configure({
        codec: msg.videoCodec,
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
      ;(self as unknown as Worker).postMessage({ type: 'ready' })
      return
    }
    if (fatal) return

    if (msg.type === 'frame') {
      const ts = Math.round((msg.n * 1e6) / FPS) // µs — INDEX-based, never wall clock
      const dur = Math.round(1e6 / FPS)
      ctx!.fillStyle = '#000'
      ctx!.fillRect(0, 0, W, H)
      if (msg.frame && msg.fit) {
        const f = msg.fit
        ctx!.save()
        if (Math.abs(f.scale - 1) > 0.001) {
          ctx!.translate(f.ox, f.oy)
          ctx!.scale(f.scale, f.scale)
          ctx!.translate(-f.ox, -f.oy)
        }
        ctx!.drawImage(msg.frame, f.dx, f.dy, f.dw, f.dh)
        ctx!.restore()
      }
      msg.frame?.close()
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
