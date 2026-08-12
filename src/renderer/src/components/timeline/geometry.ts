// Pixel<->frame geometry and shared visual constants for the timeline renderer.
// Zoom is pixels-per-second; frames convert through the document timebase.

import { framesToSeconds, secondsToFrames, type Timebase } from '@shared/timeline/time'
import type { TrackKind } from '@shared/timeline/types'
import { MIN_PX_PER_SEC, MAX_PX_PER_SEC } from '@shared/timeline/model'

export const HEADER_W = 176
export const RULER_H = 30
/** Height of an EMPTY overlay/text/subtitle lane. They collapse until content
 *  is dropped in, so the main track keeps the vertical room (waveform +
 *  thumbnails) — expanding back to their stored height once used. */
export const EMPTY_LANE_H = 22

/** The height a lane actually renders at: every EMPTY lane except the main
 *  video lane and audio lanes collapses (overlay lanes are kind 'video' too,
 *  so key off isMain, not kind). */
export function laneHeight(t: { kind: TrackKind; height: number; clips: unknown[]; isMain?: boolean }): number {
  if (!t.clips.length && !t.isMain && t.kind !== 'audio') return EMPTY_LANE_H
  return t.height
}
export const MIN_ZOOM = MIN_PX_PER_SEC
export const MAX_ZOOM = MAX_PX_PER_SEC

export function frameToPx(frame: number, zoom: number, tb: Timebase): number {
  return framesToSeconds(frame, tb) * zoom
}

export function pxToFrame(px: number, zoom: number, tb: Timebase): number {
  return secondsToFrames(px / zoom, tb)
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/** Smallest "nice" tick interval (seconds) whose on-screen spacing is >= minPx. */
export function chooseTickSeconds(zoom: number, minPx = 72): number {
  for (const s of TICK_STEPS) if (s * zoom >= minPx) return s
  return TICK_STEPS[TICK_STEPS.length - 1]
}

export function labelSeconds(sec: number): string {
  const s = Math.round(sec)
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** CapCut-ish per-track tint. */
export const TRACK_COLOR: Record<TrackKind, string> = {
  video: '#2f8f9d',
  audio: '#3f9d5a',
  text: '#b5533f',
  overlay: '#c8802f',
  subtitle: '#5b8cff',
  effect: '#b06cff',
  adjustment: '#6b7280'
}
