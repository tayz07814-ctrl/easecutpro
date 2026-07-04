// Shared zoom/pan interpolation for the base track. Used by the preview
// (VideoPreview), the editor store, and mirrored by the ffmpeg export so on-screen
// motion matches the rendered output.
import type { Ease, ZoomKeyframe } from './types'

/** Eased 0..1 progress. */
export function easeT(t: number, e: Ease): number {
  const p = Math.min(1, Math.max(0, t))
  switch (e) {
    case 'in':
      return p * p
    case 'out':
      return p * (2 - p)
    case 'inout':
      return p * p * (3 - 2 * p)
    default:
      return p
  }
}

export interface ZoomSample {
  /** scale (1 = 100%). */
  zoom: number
  /** focal point 0..1 (0.5 = centre). */
  x: number
  y: number
}

/**
 * Sample zoom + pan from keyframes at SOURCE time `t`. Holds the first/last
 * keyframe outside the range. Returns null when there are no keyframes (caller
 * falls back to the legacy start/end zoom).
 */
export function sampleZoomKeyframes(kfs: ZoomKeyframe[] | undefined, t: number): ZoomSample | null {
  if (!kfs || kfs.length === 0) return null
  const s = [...kfs].sort((a, b) => a.t - b.t)
  const first = s[0]
  const last = s[s.length - 1]
  if (t <= first.t) return { zoom: first.zoom, x: first.x, y: first.y }
  if (t >= last.t) return { zoom: last.zoom, x: last.x, y: last.y }
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]
    const b = s[i + 1]
    if (t >= a.t && t <= b.t) {
      const f = easeT((t - a.t) / Math.max(1e-6, b.t - a.t), b.ease)
      return {
        zoom: a.zoom + (b.zoom - a.zoom) * f,
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f
      }
    }
  }
  return { zoom: last.zoom, x: last.x, y: last.y }
}

/** Legacy centered start/end zoom factor at source time `t` (1 = no zoom). */
export function legacyZoomAt(
  zooms: { start: number; end: number; zoomStart: number; zoomEnd: number }[] | undefined,
  t: number
): number {
  for (const z of zooms ?? []) {
    if (t >= z.start && t < z.end) {
      const p = Math.min(1, Math.max(0, (t - z.start) / Math.max(1e-6, z.end - z.start)))
      return z.zoomStart + (z.zoomEnd - z.zoomStart) * p
    }
  }
  return 1
}

/**
 * Effective base motion at source time `t`. Keyframes need >=2 points and only
 * drive motion WITHIN their span [first..last]; outside the span (or with fewer
 * than 2 keyframes) the legacy centred start/end zoom applies. This means a stray
 * single keyframe can never silently disable the start/end zoom.
 */
export function baseMotionAt(
  project: { baseKeyframes?: ZoomKeyframe[]; baseZooms?: { start: number; end: number; zoomStart: number; zoomEnd: number }[] },
  t: number
): ZoomSample {
  const kfs = project.baseKeyframes
  if (kfs && kfs.length >= 2) {
    const sorted = [...kfs].sort((a, b) => a.t - b.t)
    if (t >= sorted[0].t && t <= sorted[sorted.length - 1].t) {
      const s = sampleZoomKeyframes(sorted, t)
      if (s) return s
    }
  }
  return { zoom: legacyZoomAt(project.baseZooms, t), x: 0.5, y: 0.5 }
}
