// Cloud VAD silence settings. On Retake 0.07 these drive the dedicated post-EDL
// planner; ProCut keeps its existing VAD adapter. The UI stores one normalized
// profile and the Retake presets also apply their matching audio crossfade.
import type { SilenceDetectOptions } from './types'

export type SilenceCutScope = 'sentences' | 'sentences_and_long_words' | 'all_word_gaps'

export interface VadSilenceSettings {
  /** Which transcript-safe gaps may be shortened after the Retake EDL. */
  scope: SilenceCutScope
  /** VAD positive-speech probability threshold 0..1 (higher = cut more). */
  speechThreshold: number
  /** minimum silence gap to remove, seconds. */
  minGapS: number
  /** natural pause duration retained after shortening an interior gap, seconds. */
  targetPauseS: number
  /** silence kept BEFORE a word's onset (lead-in guard), seconds. */
  padBeforeS: number
  /** silence kept AFTER a word's tail (trailing guard), seconds. */
  padAfterS: number
  /** extra audio trimmed off BOTH sides of every cut (tighter), seconds. */
  edgeTrimS: number
  /** also remove breaths / quiet non-word fillers the VAD kept as speech. */
  removeBreaths: boolean
  /** energy threshold (dB) below which in-speech audio is a breath/quiet filler. */
  breathDb: number
}

/** Launch defaults (= Balanced): long transcript-safe gaps, 300ms retained,
 *  120ms after the previous word + 180ms before the next. Breath removal is off. */
export const DEFAULT_VAD_SILENCE_SETTINGS: VadSilenceSettings = {
  scope: 'sentences_and_long_words',
  speechThreshold: 0.72,
  minGapS: 0.5,
  targetPauseS: 0.3,
  padBeforeS: 0.18,
  padAfterS: 0.12,
  edgeTrimS: 0,
  removeBreaths: false,
  breathDb: -34
}

/** Sanitize a possibly-partial persisted value back onto the defaults. */
export function normalizeVadSilence(v: Partial<VadSilenceSettings> | null | undefined): VadSilenceSettings {
  const d = DEFAULT_VAD_SILENCE_SETTINGS
  if (!v) return { ...d }
  const num = (x: unknown, f: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : f)
  return {
    scope: v.scope === 'sentences' || v.scope === 'sentences_and_long_words' || v.scope === 'all_word_gaps'
      ? v.scope
      : d.scope,
    speechThreshold: Math.max(0, Math.min(1, num(v.speechThreshold, d.speechThreshold))),
    minGapS: Math.max(0.03, Math.min(2, num(v.minGapS, d.minGapS))),
    targetPauseS: Math.max(0, Math.min(0.8, num(v.targetPauseS, d.targetPauseS))),
    padBeforeS: Math.max(0, Math.min(0.4, num(v.padBeforeS, d.padBeforeS))),
    padAfterS: Math.max(0, Math.min(0.4, num(v.padAfterS, d.padAfterS))),
    edgeTrimS: Math.max(0, Math.min(0.2, num(v.edgeTrimS, d.edgeTrimS))),
    removeBreaths: typeof v.removeBreaths === 'boolean' ? v.removeBreaths : d.removeBreaths,
    breathDb: Math.max(-60, Math.min(-15, num(v.breathDb, d.breathDb)))
  }
}

export interface PauseContextWord {
  start: number
  end: number
  text?: string
}

/** Editorial policy for an already word-safe VAD pause. Interior pauses are
 * eligible ONLY at a transcript sentence boundary. Rhythmic gaps inside a
 * sentence are kept even when VAD calls them silence. `shortenTo` applies only
 * to the cuttable interior, so word guards are subtracted from the desired total. */
export function decideVadPause(
  region: { start: number; end: number },
  keptWords: PauseContextWord[],
  settings: VadSilenceSettings,
  guardBeforeS: number,
  guardAfterS: number
): { action: 'keep' | 'remove' | 'shorten'; shortenTo?: number } {
  const words = [...keptWords].sort((a, b) => a.start - b.start)
  const previous = [...words].reverse().find((w) => w.end <= region.start + guardAfterS + 0.001)
  const next = words.find((w) => w.start >= region.end - guardBeforeS - 0.001)

  // Leading/trailing dead air is trim, not conversational pacing.
  if (!previous || !next) return { action: 'remove' }

  // Hard safety rule: never cut a pause inside the rhythm of a sentence. The
  // previous word must carry terminal punctuation; commas, colons, semicolons,
  // and unpunctuated gaps remain completely untouched.
  const punctuation = previous.text?.trim().slice(-1) ?? ''
  if (!/[.!?]/.test(punctuation)) return { action: 'keep' }

  if (settings.targetPauseS <= 0.001) return { action: 'remove' }
  const target = Math.max(settings.targetPauseS, 0.42)

  const interiorKeep = Math.max(0, target - guardBeforeS - guardAfterS)
  if (interiorKeep <= 0.001) return { action: 'remove' }
  return { action: 'shorten', shortenTo: Math.min(interiorKeep, region.end - region.start) }
}

/** Map the user-facing profile to the low-level VAD detector options. */
export function vadSilenceToOpts(s: VadSilenceSettings): SilenceDetectOptions {
  return {
    mode: 'vad',
    noiseDb: s.breathDb,
    minDuration: s.minGapS,
    vadThreshold: s.speechThreshold,
    padBeforeMs: Math.round(s.padBeforeS * 1000),
    padAfterMs: Math.round(s.padAfterS * 1000),
    edgeTrimMs: Math.round(s.edgeTrimS * 1000),
    removeBreaths: s.removeBreaths,
    breathDb: s.breathDb
  }
}
