// IMPORT-TIME MEDIA CONDITIONING — the reason Descript and CapCut never
// stutter, and the endgame of this codebase's long seam-stall hunt.
//
// Phone H.264 carries a keyframe every ~3 seconds; every frame between is a
// delta. Showing ANY frame therefore means decoding forward from the previous
// keyframe — up to ~90 frames for one picture. That cost lives in the MEDIA,
// not in any player, and every play-time mechanism this app has grown (dual
// decode pipes, seam prewarm, decode-through) exists only to hide it.
//
// Descript (an Electron app, ffmpeg.dll on disk) transcodes everything at
// import; CapCut generates 720p proxies by default. Neither ever plays the
// original in the editor. This module does the same: one background ffmpeg
// pass per source producing a preview copy with a keyframe every 15 frames,
// short edge capped at 720. After that, any seek anywhere costs 1–3 frames of
// decode — seams and scrubs are effectively free, on one decoder, on
// integrated graphics. Export still reads the original file; this copy is
// only ever shown, never shipped.
//
// The copy is a pure cache: keyed by path+size+mtime, safe to delete, rebuilt
// on demand. Conditioning failure means preview keeps playing the original —
// exactly today's behaviour, never worse.

import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readdir, rename, rm, stat, utimes } from 'fs/promises'
import { homedir, cpus } from 'os'
import { join } from 'path'
import { FFMPEG } from './binaries'
import { probe, runGated } from './ffmpeg'

const DIR = join(homedir(), '.easecutpro', 'cache', 'pvmedia')
/** Preview copies are per-source and rewatched constantly — keep more than the
 *  edit proxies, but still bounded. */
const KEEP = 12
/** Short-edge cap. On machines with ≤4 logical cores (integrated graphics,
 *  low-end laptops), drop to 540 so the conditioned copy is cheaper to decode
 *  and the original file is cheaper to fall back to. On 6+ cores keep 720.
 *  The file is still the same edit-friendly intra-only shape; the only
 *  difference is pixel count, and at preview-pane size it is invisible. */
const SHORT_EDGE = (cpus().length || 4) <= 4 ? 540 : 720
/** Keyframe every 15 frames (~0.5s at 30fps): any seek decodes ≤15 frames. */
const GOP = 15

const inflight = new Map<string, Promise<string>>()

async function cacheKey(src: string): Promise<string> {
  const st = await stat(src)
  return createHash('sha1').update(`${src}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex')
}

async function prune(): Promise<void> {
  try {
    const names = (await readdir(DIR)).filter((n) => n.endsWith('.mp4') && !n.endsWith('.part.mp4'))
    if (names.length <= KEEP) return
    const withTimes = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(DIR, n))).mtimeMs })))
    withTimes.sort((a, b) => a.t - b.t)
    for (const { n } of withTimes.slice(0, withTimes.length - KEEP)) {
      await rm(join(DIR, n)).catch(() => undefined)
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Return the conditioned preview copy for `src`, rendering it if needed.
 * Resolves '' when the source has no video or conditioning fails — callers
 * fall back to the original file.
 */
export async function conditionForPreview(src: string, onProgress?: (pct: number) => void): Promise<string> {
  let out: string
  try {
    if (!existsSync(src)) {
      console.warn('[pvmedia] source missing:', src)
      return ''
    }
    out = join(DIR, `${await cacheKey(src)}.mp4`)
  } catch (e) {
    console.warn('[pvmedia] cache key failed:', src, e instanceof Error ? e.message : e)
    return ''
  }
  if (existsSync(out)) {
    void utimes(out, new Date(), new Date()).catch(() => undefined)
    onProgress?.(100)
    return out
  }
  const running = inflight.get(out)
  if (running) return running

  const job = (async () => {
    await mkdir(DIR, { recursive: true })
    const info = await probe(src)
    if (!info.hasVideo || !info.width || !info.height) return ''
    // Never upscale; cap the SHORT edge so portrait and landscape both shrink.
    const portrait = info.height >= info.width
    const shortEdge = Math.min(SHORT_EDGE, portrait ? info.width : info.height)
    const w = portrait ? shortEdge : Math.round((shortEdge * info.width) / info.height)
    const h = portrait ? Math.round((shortEdge * info.height) / info.width) : shortEdge
    const tmp = out.replace(/\.mp4$/, '.part.mp4')
    const durationS = info.duration || 0

    await runGated(
      () =>
        new Promise<void>((resolve, reject) => {
          const args = [
            '-y',
            '-v', 'error',
            '-progress', 'pipe:1',
            '-i', src,
            '-vf', `scale=${w - (w % 2)}:${h - (h % 2)}`,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-g', String(GOP),
            '-bf', '0', // no B-frames: decode order == presentation order, cheapest possible seeks
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            tmp
          ]
          const child = execFile(FFMPEG, args, { maxBuffer: 1024 * 1024 * 64 }, (err) =>
            err ? reject(err) : resolve()
          )
          child.stdout?.on('data', (chunk: Buffer | string) => {
            if (!onProgress || !durationS) return
            const m = /out_time_ms=(\d+)/.exec(String(chunk))
            if (m) onProgress(Math.min(99, Math.round(Number(m[1]) / 10000 / durationS)))
          })
        })
    )
    await rename(tmp, out)
    onProgress?.(100)
    void prune()
    return out
  })().catch((e) => {
    // '' = caller falls back to the original file; log why, or failures are
    // indistinguishable from "no video track" and silently cost the smoothness.
    console.warn('[pvmedia] conditioning failed:', src, e instanceof Error ? e.message : e)
    return '' as const
  })

  inflight.set(out, job as Promise<string>)
  void (job as Promise<string>).finally(() => inflight.delete(out))
  return job
}

/** Path of an already-conditioned copy, or '' — never triggers a render. */
export async function existingPreviewMedia(src: string): Promise<string> {
  try {
    const p = join(DIR, `${await cacheKey(src)}.mp4`)
    return existsSync(p) ? p : ''
  } catch {
    return ''
  }
}
