// Native preview frame server (Windows desktop). The renderer's FfPlayer fetches
// `ecframes://frames/?p=<path>&t=<seek>` and receives raw yuv420p frames decoded
// by the BUNDLED ffmpeg — no WebCodecs, no browser codec limits, and rotation is
// applied by ffmpeg itself (a portrait phone .mov streams upright).
//
// Transport is a plain fetch ReadableStream over a privileged custom protocol:
// unlike ipcRenderer it moves bytes through Chromium's network stack (shared
// memory, real backpressure — when the renderer stops reading, ffmpeg's stdout
// pipe fills and the process stalls instead of racing ahead of the playhead).
//
// Frame geometry is decided HERE (probe + fit into a preview box, forced even
// for yuv420p) and told to the renderer in response headers, because the reader
// must know the exact byte size of a frame to slice the stream.

import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readdir, rm, stat, utimes } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { FFMPEG } from './binaries'
import { probe } from './ffmpeg'
import type { MediaInfo } from '../shared/types'

const execFileP = promisify(execFile)

// Longest output side. 1280 keeps a 1080p/4K source at 720p-class preview
// quality while holding the stream near ~40 MB/s at 30fps — comfortably inside
// what the protocol pipe moves on one machine.
const MAX_LONG = 1280
const MAX_FPS = 30

// probe() shells ffprobe (~50ms); the player restarts streams on every scrub,
// so cache per path. Keyed on path only — media files are effectively immutable
// while open in the editor.
const probeCache = new Map<string, Promise<MediaInfo>>()
function probeCached(p: string): Promise<MediaInfo> {
  let hit = probeCache.get(p)
  if (!hit) {
    hit = probe(p).catch((e) => {
      probeCache.delete(p) // don't cache failures
      throw e
    })
    probeCache.set(p, hit)
  }
  return hit
}

/** Fit (w,h) into the MAX_LONG box (never upscale), forced even for yuv420p. */
function fitEven(w: number, h: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_LONG / Math.max(w, h))
  const fw = Math.max(2, Math.round((w * scale) / 2) * 2)
  const fh = Math.max(2, Math.round((h * scale) / 2) * 2)
  return { w: fw, h: fh }
}

// Live decode processes, so a window close / app quit never leaves an orphaned
// ffmpeg spinning on a 4K file.
const liveChildren = new Set<ChildProcess>()
export function killAllFrameStreams(): void {
  for (const c of liveChildren) {
    try {
      c.kill()
    } catch {
      /* already gone */
    }
  }
  liveChildren.clear()
}

/** Protocol handler for ecframes:// — raw yuv420p frames from native ffmpeg. */
export async function handleFrameStream(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const p = decodeURIComponent(url.searchParams.get('p') ?? '')
  const t = Math.max(0, Number(url.searchParams.get('t') ?? '0') || 0)
  const frames = Math.max(0, Math.floor(Number(url.searchParams.get('frames') ?? '0') || 0))
  if (!p || !existsSync(p)) return new Response('Not Found', { status: 404 })

  let info: MediaInfo
  try {
    info = await probeCached(p)
  } catch {
    return new Response('Unprobeable', { status: 500 })
  }
  if (!info.hasVideo || !info.width || !info.height) return new Response('No video stream', { status: 415 })

  const { w, h } = fitEven(info.width, info.height)
  const fps = Math.min(MAX_FPS, Math.max(5, Math.round(info.fps) || 30))

  const args = [
    '-v', 'error',
    // HARDWARE decode when the machine offers it (D3D11VA/QuickSync/NVDEC on
    // Windows). `auto` silently falls back to software if no device or the
    // codec isn't supported, so this can only help. Frames are downloaded to
    // system memory for the rawvideo pipe, but the DECODE itself stops being
    // pure CPU — the difference between usable and unusable on older laptops.
    '-hwaccel', 'auto',
    // Input seeking: fast (keyframe jump) AND accurate (decode+discard to t).
    // Output timestamps restart at 0, so the fps grid aligns to the seek point
    // and frame k sits at t + k/fps — which is how the renderer stamps them.
    '-ss', t.toFixed(3),
    '-i', p,
    '-an', '-sn',
    '-vf', `scale=${w}:${h}:flags=bilinear,fps=${fps}`,
    ...(frames > 0 ? ['-frames:v', String(frames)] : []),
    '-f', 'rawvideo',
    '-pix_fmt', 'yuv420p',
    'pipe:1'
  ]
  const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  liveChildren.add(child)
  child.stderr?.resume() // drain; -v error keeps it near-silent
  const cleanup = (): void => {
    liveChildren.delete(child)
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  child.once('exit', () => liveChildren.delete(child))

  const stdout = child.stdout!
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      stdout.on('data', (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk))
        } catch {
          cleanup() // consumer already gone
          return
        }
        // Default (count) queuing strategy: pause until the consumer pulls —
        // this plus the OS pipe buffer is the whole backpressure story.
        if ((controller.desiredSize ?? 1) <= 0) stdout.pause()
      })
      stdout.once('end', () => {
        try {
          controller.close()
        } catch {
          /* already errored/cancelled */
        }
        cleanup()
      })
      stdout.once('error', (e) => {
        try {
          controller.error(e)
        } catch {
          /* already closed */
        }
        cleanup()
      })
    },
    pull: () => {
      stdout.resume()
    },
    cancel: cleanup
  })

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-EC-W': String(w),
      'X-EC-H': String(h),
      'X-EC-FPS': String(fps),
      'X-EC-T0': t.toFixed(3)
    }
  })
}

// ---- Preview audio: whole-source PCM via native ffmpeg ------------------------

const previewAudioDir = (): string => join(homedir(), '.easecutpro', 'previewaudio')
const PREVIEW_AUDIO_KEEP = 40

/** Best-effort LRU prune so the cache can't grow unbounded. */
async function prunePreviewAudio(): Promise<void> {
  try {
    const dir = previewAudioDir()
    const names = (await readdir(dir)).filter((n) => n.endsWith('.wav'))
    if (names.length <= PREVIEW_AUDIO_KEEP) return
    const withTimes = await Promise.all(
      names.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs }))
    )
    withTimes.sort((a, b) => a.t - b.t)
    for (const { n } of withTimes.slice(0, withTimes.length - PREVIEW_AUDIO_KEEP)) {
      await rm(join(dir, n)).catch(() => undefined)
    }
  } catch {
    /* pruning is best-effort */
  }
}

/**
 * Extract a source's FULL audio as a 48k stereo s16 WAV for the preview engine.
 * `aresample=async=1:first_pts=0` bakes in the phone-.mov `elst` audio delay, so
 * the renderer needs no mp4AudioStartOffset()/padLeadingSilence() on this path —
 * the WAV timeline IS the video timeline. Cached by (path,size,mtime); the WAV
 * streams back over ecmedia:// and decodeAudioData only unwraps the container.
 */
export async function extractPreviewAudioWav(path: string): Promise<string> {
  const st = await stat(path)
  const key = createHash('sha1').update(`${path}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex')
  const dir = previewAudioDir()
  await mkdir(dir, { recursive: true })
  const out = join(dir, `${key}.wav`)
  if (existsSync(out)) {
    void utimes(out, new Date(), new Date()).catch(() => undefined) // refresh LRU
    return out
  }
  await execFileP(FFMPEG, [
    '-y', '-v', 'error',
    '-i', path,
    '-vn',
    '-af', 'aresample=async=1:first_pts=0',
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    out
  ], { maxBuffer: 1024 * 1024 * 16 })
  void prunePreviewAudio()
  return out
}
