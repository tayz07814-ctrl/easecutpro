// Smart Silence Cleaner — data models.
//
// Faithful TypeScript port of the canonical Python engine's data types:
//   - smart_silence_cleaner/models/word.py   (Word)
//   - smart_silence_cleaner/models/settings.py (SilenceSettings)
//   - smart_silence_cleaner/models/presets.py  (Preset)
//   - smart_silence_cleaner/models/edl.py      (Cut / SilencePlan / EDL rows)
//   - smart_silence_cleaner/engine/stats.py    (Stats)
//
// All times are MILLISECONDS internally; seconds are produced only for FFmpeg
// export (see `cutAsRow` / `keepRangesS`). Field names are camelCase per the
// port brief (minGapMs, targetPauseMs, sentencePauseMs, …).

/** One transcript token with its AssemblyAI-style start/end offset (ms). */
export interface Word {
  startMs: number
  endMs: number
  /** Raw token text, punctuation preserved (it drives the pause rules). */
  text: string
}

export type CutReason = 'gap' | 'filler'

/** One span of media to delete. `removedMs === endMs - startMs`. */
export interface Cut {
  startMs: number
  endMs: number
  removedMs: number
  reason: CutReason
}

/** Every knob the silence engine understands (port of SilenceSettings). */
export interface SilenceSettings {
  // raw parameters (Advanced panel) ---------------------------------------
  minGapMs: number
  targetPauseMs: number
  sentencePauseMs: number
  commaPauseMs: number
  mergeGapMs: number
  padBeforeMs: number
  padAfterMs: number
  // toggles ---------------------------------------------------------------
  keepSentenceFlow: boolean
  removeFillers: boolean
  smartSilence: boolean
}

/** A named editing mode shown as a large card in the UI. */
export interface Preset {
  id: string
  icon: string
  title: string
  description: string
  settings: SilenceSettings
  /** Custom is the only mode whose sliders/advanced params are user-editable. */
  editable: boolean
}

/** Everything the Statistics + Export-Preview panels display. */
export interface Stats {
  originalDurationMs: number
  outputDurationMs: number
  timeSavedMs: number
  /** 0-100. */
  percentRemoved: number
  speechDurationMs: number
  silenceDurationMs: number
  pausesTotal: number
  pausesRemoved: number
  fillersRemoved: number
  averagePauseMs: number
  longestPauseMs: number
}

/** A flat EDL export row (seconds for FFmpeg + ms + reason). */
export interface EdlRow {
  cut_start_s: number
  cut_end_s: number
  cut_start_ms: number
  cut_end_ms: number
  duration_removed_ms: number
  reason: CutReason
}

/** The single object the engine hands back for one settings run. */
export interface SilencePlan {
  /** Ordered, non-overlapping spans to remove. */
  cuts: Cut[]
  /** Complement of `cuts` over [0, originalDurationMs] — the KEEP ranges. */
  keeps: Array<[number, number]>
  stats: Stats
  originalDurationMs: number
}

// --------------------------------------------------------------------------- //
// Python-compatible rounding shims                                            //
// --------------------------------------------------------------------------- //
// Python's round() is round-half-to-even (banker's rounding); JS Math.round is
// round-half-up. Replicated so numbers exported from the port match the Python
// engine exactly (`to_sliders`, EDL rows, duration formatting).

/** round-half-to-even, matching Python's built-in round() for non-negatives. */
export function pyRound(x: number): number {
  const f = Math.floor(x)
  const diff = x - f
  if (diff < 0.5) return f
  if (diff > 0.5) return f + 1
  return f % 2 === 0 ? f : f + 1
}

/** round to `ndigits` decimals, banker's rounding — matches Python round(x, n). */
export function pyRoundTo(x: number, ndigits: number): number {
  const m = Math.pow(10, ndigits)
  return pyRound(x * m) / m
}

// --------------------------------------------------------------------------- //
// Cut seconds accessors + EDL rows (mirror models/edl.py)                     //
// --------------------------------------------------------------------------- //

/** Cut start in seconds (FFmpeg -ss). */
export const cutStartS = (c: Cut): number => c.startMs / 1000
/** Cut end in seconds (FFmpeg -to). */
export const cutEndS = (c: Cut): number => c.endMs / 1000

/** Flat dict for EDL export / logging (seconds + ms + reason). */
export function cutAsRow(c: Cut): EdlRow {
  return {
    cut_start_s: pyRoundTo(cutStartS(c), 3),
    cut_end_s: pyRoundTo(cutEndS(c), 3),
    cut_start_ms: pyRoundTo(c.startMs, 1),
    cut_end_ms: pyRoundTo(c.endMs, 1),
    duration_removed_ms: pyRoundTo(c.removedMs, 1),
    reason: c.reason,
  }
}

/** The EDL as a list of flat rows (Cut Start / Cut End / Duration Removed). */
export const edlRows = (plan: SilencePlan): EdlRow[] => plan.cuts.map(cutAsRow)

/** KEEP ranges in seconds — the segments FFmpeg should concatenate. */
export const keepRangesS = (plan: SilencePlan): Array<[number, number]> =>
  plan.keeps.map(([a, b]) => [a / 1000, b / 1000])
