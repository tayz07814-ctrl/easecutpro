// Cache managers over window.api: fetch + cache audio peaks and filmstrip frames
// per source path, dedup in-flight requests, and bump a version when new data
// lands so the timeline re-renders. Renderer-side (uses the preload/web api,
// which mirrors extractWaveform / extractThumbnails). This is the real-app
// backing for MediaData; the standalone preview uses a synthetic provider.

import type { Clip } from '@shared/timeline/types'
import type { ClipFrame, ClipWaveform, MediaData } from './MediaData'
import { mediaSrc } from '../../platform'

interface Fetcher {
  waveform(path: string): Promise<ClipWaveform>
  thumbnails(
    path: string,
    onPartial?: (frames: ClipFrame[]) => void,
    fromSec?: number,
    toSec?: number,
    intervalSec?: number
  ): Promise<ClipFrame[]>
}

export interface MediaManager extends MediaData {
  subscribe(fn: () => void): () => void
  getVersion(): number
  dispose(): void
}

export function createMediaManager(fetcher?: Fetcher): MediaManager {
  const fx: Fetcher =
    fetcher ?? {
      waveform: (p) => window.api.waveform(p),
      thumbnails: (p, onPartial, fromSec, toSec, intervalSec) =>
        window.api.thumbnails(p, intervalSec, onPartial, fromSec, toSec)
    }

  const waves = new Map<string, ClipWaveform>()
  const frames = new Map<string, ClipFrame[]>()
  // ZOOM DETAIL TIERS. The base strip covers the whole clip at a bounded frame
  // count, which is right when zoomed out but far too coarse close up — the
  // filmstrip picks the NEAREST frame per tile, so a sparse strip shows the same
  // still repeated instead of the footage moving. When the view needs a finer
  // interval than the base provides we fetch a detail strip for just the visible
  // WINDOW (ffmpeg input-seeks straight to it, so it costs a fraction of the
  // clip) and merge it over the base. Keyed by window bucket so panning and
  // re-zooming reuse what's already there.
  const detail = new Map<string, ClipFrame[]>()
  const inflight = new Set<string>()
  const listeners = new Set<() => void>()
  let version = 0

  const notify = (): void => {
    version++
    for (const l of listeners) l()
  }

  const ensureWave = (path: string): void => {
    const key = 'w:' + path
    if (waves.has(path) || inflight.has(key)) return
    inflight.add(key)
    fx.waveform(path)
      .then((wf) => {
        waves.set(path, wf)
        inflight.delete(key)
        notify()
      })
      // Cache the failure (empty peaks) so we never re-request the same bad source
      // every render — that was hammering ffmpeg for still images / decode errors.
      .catch(() => {
        waves.set(path, { peaksPerSec: 1, peaks: [] })
        inflight.delete(key)
      })
  }

  const ensureFrames = (path: string): void => {
    const key = 't:' + path
    if (frames.has(path) || inflight.has(key)) return
    inflight.add(key)
    // Render the filmstrip PROGRESSIVELY: each frame that lands updates the cache
    // and re-renders, so a long clip shows thumbnails as they generate instead of
    // staying blank until the whole strip is done.
    fx.thumbnails(path, (partial) => {
      frames.set(path, partial)
      notify()
    })
      .then((th) => {
        frames.set(path, th)
        inflight.delete(key)
        notify()
      })
      .catch(() => {
        frames.set(path, []) // cache the failure — no infinite retry
        inflight.delete(key)
      })
  }

  /** Fetch a detail strip for one window, once. */
  const ensureDetail = (path: string, key: string, from: number, to: number, interval: number): void => {
    if (detail.has(key) || inflight.has(key)) return
    inflight.add(key)
    fx.thumbnails(path, undefined, from, to, interval)
      .then((th) => {
        detail.set(key, th)
        inflight.delete(key)
        // Bound the detail cache — these are base64 stills and a long session
        // panning around a timeline would otherwise accumulate forever.
        while (detail.size > 12) {
          const oldest = detail.keys().next().value
          if (oldest === undefined) break
          detail.delete(oldest)
        }
        notify()
      })
      .catch(() => {
        detail.set(key, [])
        inflight.delete(key)
      })
  }

  return {
    getWaveform(clip: Clip): ClipWaveform | null {
      if (!clip.hasAudio || clip.audioDetached || !clip.sourcePath) return null
      const cached = waves.get(clip.sourcePath)
      if (cached) return cached
      ensureWave(clip.sourcePath)
      return null
    },
    getFrames(clip: Clip, want?: { interval: number; from: number; to: number }): ClipFrame[] | null {
      if (!clip.sourcePath) return null
      // Still images have no decodable filmstrip — running ffmpeg fps sampling on
      // them fails ("no filtered frames"), so show the image itself as the tile.
      if (clip.kind === 'image') return [{ time: clip.sourceIn, url: mediaSrc(clip.sourcePath) }]
      const cached = frames.get(clip.sourcePath)
      if (!cached) {
        ensureFrames(clip.sourcePath)
        return null
      }
      // Does the base strip already resolve what the view is asking for?
      if (want && want.interval > 0 && cached.length > 1) {
        const baseInterval = cached[1].time - cached[0].time
        if (baseInterval > want.interval * 1.5) {
          // Quantise the window so small pans reuse the same fetch.
          const span = Math.max(want.interval * 40, 2)
          const from = Math.max(0, Math.floor(want.from / span) * span)
          const to = from + span * 2
          const key = `d:${clip.sourcePath}|${want.interval.toFixed(3)}|${from.toFixed(1)}`
          const fine = detail.get(key)
          if (fine === undefined) ensureDetail(clip.sourcePath, key, from, to, want.interval)
          else if (fine.length) return [...cached, ...fine].sort((a, b) => a.time - b.time)
        }
      }
      return cached
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    getVersion: () => version,
    dispose() {
      listeners.clear()
      waves.clear()
      frames.clear()
      inflight.clear()
    }
  }
}
