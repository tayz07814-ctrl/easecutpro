// PREVIEW PROXY — the desktop equivalent of Media3's CompositionPlayer.
//
// The mobile app hands the whole cut list to one player as a single composition,
// so a cut is a SKIP INSIDE ONE DECODE SESSION: the decoder is never re-primed,
// and playback is smooth however many cuts there are. On desktop there is no
// such API, and every seam is a seek — find the preceding keyframe, decode
// forward, resync audio — which no amount of CPU makes free. It is why heavily
// cut timelines stutter.
//
// So we flatten instead: render the CURRENT EDIT to one small file and play that.
// A cut stops existing at playback time because the removed footage isn't in the
// file. One decode, no seams, no seeking.
//
// The proxy is DISPOSABLE and always regenerable:
//   • keyed by a signature of the edit, so a stale proxy can never be shown
//   • small (540p, fast preset) — this is for watching, not delivering
//   • the editor stays fully usable while it builds; the existing engine plays
//     until a matching proxy exists, and keeps playing if this ever fails
//
// It uses a dedicated fast renderer. Kept ranges still come from the shared edit
// model, but disposable preview encoding never pays export-level filter/quality
// costs.

import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readdir, rename, rm, stat, utimes } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { buildFastPreviewProxy } from './fastPreviewProxy'
import type { Project } from '../shared/types'

const PROXY_DIR = join(homedir(), '.easecutpro', 'cache', 'proxy')
/** Proxies are cheap to rebuild and large on disk; keep only a few recent ones. */
const KEEP = 6
/** Short edge. 540p is plenty for a preview pane and renders fast. */
const SHORT_EDGE = 540
/** Short edge for a USER-REQUESTED proxy ("Make Preview Proxy" button).
 *  720p is more than enough for the preview pane, renders fast enough on
 *  any machine with a dedicated GPU, and the user explicitly asked for it. */
const SHORT_EDGE_MANUAL = 720

/** Live builds, so a second request for the same edit joins the first. */
const inflight = new Map<string, Promise<string>>()
const controllers = new Map<string, AbortController>()

function proxyPath(signature: string): string {
  return join(PROXY_DIR, `${createHash('sha1').update(signature).digest('hex')}.mp4`)
}

/** Keep the newest few proxies; they're regenerable, so pruning is safe. */
async function prune(): Promise<void> {
  try {
    // `.part.mp4` files are renders in flight — deleting one would kill a build.
    const names = (await readdir(PROXY_DIR)).filter((n) => n.endsWith('.mp4') && !n.endsWith('.part.mp4'))
    if (names.length <= KEEP) return
    const withTimes = await Promise.all(
      names.map(async (n) => ({ n, t: (await stat(join(PROXY_DIR, n))).mtimeMs }))
    )
    withTimes.sort((a, b) => a.t - b.t)
    for (const { n } of withTimes.slice(0, withTimes.length - KEEP)) {
      await rm(join(PROXY_DIR, n)).catch(() => undefined)
    }
  } catch {
    /* pruning is best-effort */
  }
}

/**
 * Render (or reuse) a flat proxy of `project`'s current edit.
 *
 * `signature` must change whenever the edit changes — the renderer derives it
 * from the timeline segments, and only plays a proxy whose signature still
 * matches what is on screen. That's what makes showing a stale cut impossible.
 */
export async function buildPreviewProxy(
  project: Project,
  signature: string,
  onProgress?: (pct: number) => void,
  manualQuality = false
): Promise<string> {
  const out = proxyPath(signature)
  if (existsSync(out)) {
    void utimes(out, new Date(), new Date()).catch(() => undefined) // refresh LRU
    onProgress?.(100)
    return out
  }
  const running = inflight.get(signature)
  if (running) return running

  // A changed edit supersedes obsolete disposable work. The renderer already
  // refuses stale results by signature; aborting here also stops wasting CPU.
  for (const [oldSignature, controller] of controllers) {
    if (oldSignature !== signature) controller.abort()
  }

  const shortEdge = manualQuality ? SHORT_EDGE_MANUAL : SHORT_EDGE
  const controller = new AbortController()
  controllers.set(signature, controller)

  const job = (async () => {
    await mkdir(PROXY_DIR, { recursive: true })
    // Written to a temp name first: a half-written file must never be picked up
    // as a valid proxy by a later run that only checks existence. The `.mp4`
    // stays LAST — ffmpeg picks its container from the extension, so a bare
    // `.part` suffix would fail with "unable to find a suitable output format".
    const tmp = out.replace(/\.mp4$/, '.part.mp4')
    try {
      await buildFastPreviewProxy(
        project,
        tmp,
        { shortEdge, bitrateMbps: manualQuality ? 2 : 1.25 },
        onProgress ?? (() => undefined),
        controller.signal
      )
      if (controller.signal.aborted) throw new Error('preview proxy superseded')
      await rename(tmp, out)
    } catch (e) {
      await rm(tmp).catch(() => undefined)
      throw e
    }
    void prune()
    return out
  })().finally(() => {
    inflight.delete(signature)
    controllers.delete(signature)
  })

  inflight.set(signature, job)
  return job
}

/** Path for a signature if a proxy is already on disk, else ''. */
export function existingProxy(signature: string): string {
  const p = proxyPath(signature)
  return existsSync(p) ? p : ''
}
