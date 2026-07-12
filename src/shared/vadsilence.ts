// Unified VAD silence-cutting settings — shared by cloud ProCut AND Retake β.
//
// One tunable profile drives a single raw-VAD silence pass (Silero speech
// detection + asymmetric guard padding + edge trim + breath/quiet-filler
// removal). This REPLACES Retake β's transcript-gap hybrid and ProCut's
// Opus-decided pause cuts in the cloud build: both engines now cut silence the
// same way, and the one 🔇 Silence Settings modal edits this profile.
import type { SilenceDetectOptions } from './types'

export interface VadSilenceSettings {
  /** VAD positive-speech probability threshold 0..1 (higher = cut more). */
  speechThreshold: number
  /** minimum silence gap to remove, seconds. */
  minGapS: number
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

/** Launch defaults. Breath/quiet-filler removal is OFF until the user opts in
 *  (it's the most aggressive control); the rest are the tuned silence values. */
export const DEFAULT_VAD_SILENCE_SETTINGS: VadSilenceSettings = {
  speechThreshold: 0.8,
  minGapS: 0.1,
  padBeforeS: 0.1,
  padAfterS: 0.07,
  edgeTrimS: 0,
  removeBreaths: false,
  breathDb: -30
}

/** Sanitize a possibly-partial persisted value back onto the defaults. */
export function normalizeVadSilence(v: Partial<VadSilenceSettings> | null | undefined): VadSilenceSettings {
  const d = DEFAULT_VAD_SILENCE_SETTINGS
  if (!v) return { ...d }
  const num = (x: unknown, f: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : f)
  return {
    speechThreshold: Math.max(0.3, Math.min(0.95, num(v.speechThreshold, d.speechThreshold))),
    minGapS: Math.max(0.03, Math.min(2, num(v.minGapS, d.minGapS))),
    padBeforeS: Math.max(0, Math.min(0.4, num(v.padBeforeS, d.padBeforeS))),
    padAfterS: Math.max(0, Math.min(0.4, num(v.padAfterS, d.padAfterS))),
    edgeTrimS: Math.max(0, Math.min(0.2, num(v.edgeTrimS, d.edgeTrimS))),
    removeBreaths: typeof v.removeBreaths === 'boolean' ? v.removeBreaths : d.removeBreaths,
    breathDb: Math.max(-60, Math.min(-15, num(v.breathDb, d.breathDb)))
  }
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
