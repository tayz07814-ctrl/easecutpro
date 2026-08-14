// Cache managers over window.api: fetch + cache audio peaks and filmstrip frames
// per source path, dedup in-flight requests, and bump a version when new data
// lands so the timeline re-renders. Renderer-side (uses the preload/web api,
// which mirrors extractWaveform / extractThumbnails). This is the real-app
// backing for MediaData; the standalone preview uses a synthetic provider.

import type { Clip } from '@shared/timeline/types'
import type { ClipFrame, ClipWaveform, MediaData } from './MediaData'
import { mediaSrc } from '../../platform'

interface Fetcher {
  waveform(path: string, peaksPerSec?: number): Promise<ClipWaveform>
  thumbnails(path: string, intervalSec?: number, onPartial?: (frames: ClipFrame[]) => void): Promise<ClipFrame[]>
}

export interface MediaManager extends MediaData {
  subscribe(fn: () => void): () => void
  getVersion(): number
  dispose(): void
}

export function createMediaManager(fetcher?: Fetcher): MediaManager {
  const fx: Fetcher =
    fetcher ?? {
      waveform: (p, peaksPerSec) => window.api.waveform(p, peaksPerSec),
      thumbnails: (p, intervalSec, onPartial) => window.api.thumbnails(p, intervalSec, onPartial)
    }

  const waves = new Map<string, ClipWaveform>()
  const frames = new Map<string, ClipFrame[]>()
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
    // The timeline only needs a display envelope. Keep the analysis/export path
    // at its existing resolution, but halve the decoder work for this low-cost
    // visual request on older CPUs.
    fx.waveform(path, 30)
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
    // Two-stage filmstrip: a single keyframe arrives quickly and paints the clip
    // immediately; the denser strip follows in the background. This is much more
    // responsive than waiting for a complete FFmpeg pass on older Intel CPUs.
    void fx.thumbnails(path, 60)
      .then((first) => {
        if (first.length) {
          frames.set(path, first)
          notify()
        }
      })
      .catch(() => undefined)
      .then(() =>
        fx.thumbnails(path, undefined, (partial) => {
          frames.set(path, partial)
          notify()
        })
      )
      .then((th) => {
        frames.set(path, th)
        inflight.delete(key)
        notify()
      })
      .catch(() => {
        // Preserve a fast first frame if the refinement pass fails.
        if (!frames.has(path)) frames.set(path, [])
        inflight.delete(key)
        notify()
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
    getFrames(clip: Clip): ClipFrame[] | null {
      if (!clip.sourcePath) return null
      // Still images have no decodable filmstrip — running ffmpeg fps sampling on
      // them fails ("no filtered frames"), so show the image itself as the tile.
      if (clip.kind === 'image') return [{ time: clip.sourceIn, url: mediaSrc(clip.sourcePath) }]
      const cached = frames.get(clip.sourcePath)
      if (cached) return cached
      ensureFrames(clip.sourcePath)
      return null
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
