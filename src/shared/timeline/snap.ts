// Snapping: collect candidate target frames (clip edges, playhead, markers, 0)
// and find the smallest shift that lands a moving edge on one, within a
// pixel-derived frame threshold. Pure — the engine feeds it the document.

import type { TimelineDocument } from './types'
import { secondsToFrames, type Timebase } from './time'

export interface SnapResult {
  /** frames to add to the candidate so an edge lands on `line`. */
  delta: number
  /** the target frame a guide should be drawn at. */
  line: number
}

/** Every snap target: clip edges (except excluded clips), the playhead, markers, and 0. */
export function collectSnapPoints(
  doc: TimelineDocument,
  exclude: Set<string>,
  playhead: number
): number[] {
  const pts = new Set<number>()
  pts.add(0)
  pts.add(playhead)
  for (const m of doc.markers) pts.add(m.frame)
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (exclude.has(c.id)) continue
      pts.add(c.start)
      pts.add(c.end)
    }
  }
  return [...pts].sort((a, b) => a - b)
}

/** Convert a pixel snap threshold to whole frames at the current zoom. */
export function snapThresholdFrames(px: number, zoom: number, tb: Timebase): number {
  return Math.max(1, secondsToFrames(px / zoom, tb))
}

/**
 * Given moving edges (e.g. [start, end] for a move, or [edge] for a trim) and
 * candidate points, return the smallest shift landing any edge on a point
 * within threshold, or null.
 */
export function snapEdges(
  edges: number[],
  points: number[],
  thresholdFrames: number
): SnapResult | null {
  let best: SnapResult | null = null
  for (const edge of edges) {
    for (const p of points) {
      const d = p - edge
      if (Math.abs(d) <= thresholdFrames && (!best || Math.abs(d) < Math.abs(best.delta))) {
        best = { delta: d, line: p }
      }
    }
  }
  return best
}
