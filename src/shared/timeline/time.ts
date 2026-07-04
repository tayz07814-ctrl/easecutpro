// Frame-accurate time model. The timeline's canonical unit is the integer FRAME
// at the project timebase; everything on a track (clip positions, durations, the
// playhead) is frames, so snapping, ripple and split math are exact and
// drift-free. Source media in/out points stay in SECONDS — that's what the
// demuxer reports — and are converted through the clip's own speed.

export interface Timebase {
  /** frames-per-second numerator (e.g. 30000 for 29.97). */
  num: number
  /** frames-per-second denominator (e.g. 1001 for 29.97; 1 for integer fps). */
  den: number
}

export const FPS_24: Timebase = { num: 24, den: 1 }
export const FPS_2500: Timebase = { num: 25, den: 1 }
export const FPS_30: Timebase = { num: 30, den: 1 }
export const FPS_50: Timebase = { num: 50, den: 1 }
export const FPS_60: Timebase = { num: 60, den: 1 }
export const FPS_2398: Timebase = { num: 24000, den: 1001 }
export const FPS_2997: Timebase = { num: 30000, den: 1001 }
export const FPS_5994: Timebase = { num: 60000, den: 1001 }

export function fps(tb: Timebase): number {
  return tb.num / tb.den
}

/** Build an exact timebase from a probed fps, recognizing the NTSC fractional rates. */
export function timebaseFromFps(f: number): Timebase {
  if (!isFinite(f) || f <= 0) return FPS_30
  const ntsc: Array<[number, Timebase]> = [
    [23.976, FPS_2398],
    [29.97, FPS_2997],
    [59.94, FPS_5994]
  ]
  for (const [rate, tb] of ntsc) if (Math.abs(f - rate) < 0.02) return tb
  const rounded = Math.round(f)
  if (Math.abs(f - rounded) < 1e-6) return { num: rounded, den: 1 }
  // Arbitrary rate: keep it as a milli-fps rational (exact enough, no drift).
  return { num: Math.round(f * 1000), den: 1000 }
}

export function secondsToFrames(sec: number, tb: Timebase): number {
  return Math.round((sec * tb.num) / tb.den)
}

export function framesToSeconds(frames: number, tb: Timebase): number {
  return (frames * tb.den) / tb.num
}

/** Duration of a single frame, in seconds. */
export function frameSeconds(tb: Timebase): number {
  return tb.den / tb.num
}

/** Snap an arbitrary seconds value to the nearest whole-frame boundary (returns seconds). */
export function snapSecondsToFrame(sec: number, tb: Timebase): number {
  return framesToSeconds(secondsToFrames(sec, tb), tb)
}

export function clampFrames(f: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = Math.round(f)
  return v < min ? min : v > max ? max : v
}

/** Format frames as HH:MM:SS:FF (drop-frame not applied — display only). */
export function formatTimecode(frames: number, tb: Timebase): string {
  const rate = Math.round(fps(tb))
  const f = Math.max(0, Math.round(frames))
  const ff = f % rate
  const totalSec = Math.floor(f / rate)
  const ss = totalSec % 60
  const mm = Math.floor(totalSec / 60) % 60
  const hh = Math.floor(totalSec / 3600)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`
}
