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
  thumbnails(path: string): Promise<ClipFrame[]>
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
      thumbnails: (p) => window.api.thumbnails(p)
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
    fx.thumbnails(path)
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
