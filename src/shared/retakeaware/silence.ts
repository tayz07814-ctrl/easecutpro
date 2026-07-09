// Retake β — CONSERVATIVE, word-clamped silence path.
//
// Retake β does NOT use the shared FastCut/ProCut Cut Lord VAD settings (minGap
// 0.15s, edgeTrim 0.1s into speech, aggressive). It runs its own gentle VAD
// profile and then CLAMPS every region against the transcript word timestamps
// (which Retake β always has) so a cut can never touch the last word before or
// the first word after a pause. Output regions are `action:'remove'` of the
// guarded CENTRE only, marked `protect:true` so computeKeepRanges applies them
// verbatim (no edgeTrim / valley-snap / blip-absorb / bridge). This module is
// PURE (the clamp) — the VAD scan itself runs in the engine via ffmpeg.
import type { SilenceRegion } from '../types'
import type { VerbatimWord, CutSpan } from './types'
import type { SilenceDetectOptions } from '../types'

// ---- gentle VAD profile (never the aggressive Cut Lord preset) ----
export const RETAKE_BETA_MIN_GAP_S = 0.7 // ignore raw gaps under this (breaths)
export const RETAKE_BETA_MIN_GAP_SAFE_S = 0.85 // beta-safe mode
/** VAD options for Retake β's own silence scan. speechPad keeps well back from
 *  speech; edgeTrim 0 (never cut INTO speech); breaths never removed. */
export function retakeBetaVadOpts(betaSafe = false): SilenceDetectOptions {
  return {
    mode: 'vad',
    noiseDb: -30, // fallback only (unused in vad mode)
    minDuration: betaSafe ? RETAKE_BETA_MIN_GAP_SAFE_S : RETAKE_BETA_MIN_GAP_S,
    vadThreshold: 0.5,
    speechPadMs: 220, // keep well back from detected speech
    edgeTrimMs: 0, // NEVER eat into speech
    removeBreaths: false // no aggressive breath removal
  }
}

// ---- word-clamp guards ----
const LEFT_GUARD_S = 0.22 // previous word tail
const LEFT_GUARD_FRAGILE_S = 0.32
const RIGHT_GUARD_S = 0.28 // next word preroll
const RIGHT_GUARD_FRAGILE_S = 0.38
const MIN_CENTER_S = 0.3 // below this removable centre → drop
// A protected silence cut must stay this far from a word cut so the shared
// island-absorption (MIN_ISLAND 0.4s) + word-cut valley-snap (±0.12s) can never
// eat the kept speech between them.
const WORD_CUT_SEPARATION_S = 0.55
const FRAGILE = new Set([
  'i', 'it', 'a', 'an', 'and', 'but', 'so', 'the', 'to', 'is', 'was', 'has', 'have', 'in', 'on', 'of', 'or', 'uh', 'um'
])
const normWord = (w: string): string => w.toLowerCase().replace(/[^a-z']/g, '')
const ALIGN_TOL_S = 0.25 // VAD/word timestamp misalignment tolerance

export interface BetaSilenceDebugRegion {
  raw_start: number
  raw_end: number
  raw_gap_ms: number
  nearest_previous_word: string | null
  nearest_next_word: string | null
  previous_word_guard_ms: number
  next_word_guard_ms: number
  final_start: number | null
  final_end: number | null
  kept: boolean
  drop_reason: '' | 'under_min_gap' | 'overlap_word_cut' | 'guard_left_too_little_center' | 'word_cut_separation'
}

export interface BetaSilenceResult {
  regions: SilenceRegion[]
  debug: {
    retake_beta_vad_profile: { min_gap_s: number; speech_pad_ms: number; edge_trim_ms: number; remove_breaths: boolean }
    raw_vad_silence_regions: number
    silence_regions_after_min_gap: number
    silence_regions_after_word_clamp: number
    silence_regions_dropped_too_short: number
    silence_regions_dropped_overlap_word_cut: number
    silence_regions_dropped_due_to_guard: number
    final_retake_beta_silence_regions: number
    total_silence_removed_s: number
    per_region: BetaSilenceDebugRegion[]
  }
}

/** Clamp raw VAD silence regions against transcript words + word cuts. PURE. */
export function clampBetaSilences(
  vadRegions: { start: number; end: number }[],
  words: VerbatimWord[],
  wordCutSpans: CutSpan[],
  betaSafe = false
): BetaSilenceResult {
  const minGap = betaSafe ? RETAKE_BETA_MIN_GAP_SAFE_S : RETAKE_BETA_MIN_GAP_S
  const ms = (s: number): number => Math.round(s * 1000)
  const regions: SilenceRegion[] = []
  const per: BetaSilenceDebugRegion[] = []
  let afterMinGap = 0
  let droppedShort = 0
  let droppedOverlap = 0
  let droppedGuard = 0

  const overlapsWordCut = (a: number, b: number): boolean =>
    wordCutSpans.some((s) => a < s.end && s.start < b)
  const sorted = [...vadRegions].sort((x, y) => x.start - y.start)

  for (const raw of sorted) {
    const rawGap = raw.end - raw.start
    const rec: BetaSilenceDebugRegion = {
      raw_start: raw.start, raw_end: raw.end, raw_gap_ms: ms(rawGap),
      nearest_previous_word: null, nearest_next_word: null,
      previous_word_guard_ms: 0, next_word_guard_ms: 0,
      final_start: null, final_end: null, kept: false, drop_reason: ''
    }
    // 1. breath protection: ignore raw gaps under the floor.
    if (rawGap < minGap) { rec.drop_reason = 'under_min_gap'; per.push(rec); continue }
    afterMinGap++
    // 2. overlap with a word cut → drop (that region is being removed already).
    if (overlapsWordCut(raw.start, raw.end)) { rec.drop_reason = 'overlap_word_cut'; droppedOverlap++; per.push(rec); continue }

    // 3. nearest previous / next transcript word (with misalignment tolerance).
    let prev: VerbatimWord | null = null
    let next: VerbatimWord | null = null
    for (const w of words) {
      if (w.end <= raw.start + ALIGN_TOL_S && (!prev || w.end > prev.end)) prev = w
      if (w.start >= raw.end - ALIGN_TOL_S && (!next || w.start < next.start)) next = w
    }
    rec.nearest_previous_word = prev ? prev.word : null
    rec.nearest_next_word = next ? next.word : null
    const leftGuard = prev ? (FRAGILE.has(normWord(prev.word)) ? LEFT_GUARD_FRAGILE_S : LEFT_GUARD_S) : 0
    const rightGuard = next ? (FRAGILE.has(normWord(next.word)) ? RIGHT_GUARD_FRAGILE_S : RIGHT_GUARD_S) : 0
    rec.previous_word_guard_ms = ms(leftGuard)
    rec.next_word_guard_ms = ms(rightGuard)

    // 4. word-edge safety clamp: never within guard of either word.
    let cutStart = prev ? Math.max(raw.start, prev.end + leftGuard) : raw.start
    let cutEnd = next ? Math.min(raw.end, next.start - rightGuard) : raw.end

    // 5. keep >= WORD_CUT_SEPARATION from any word cut (so the shared cleanup
    //    can't bridge/absorb the kept speech between a silence and a word cut).
    for (const s of wordCutSpans) {
      if (s.end <= cutStart && s.end > cutStart - WORD_CUT_SEPARATION_S) cutStart = s.end + WORD_CUT_SEPARATION_S
      if (s.start >= cutEnd && s.start < cutEnd + WORD_CUT_SEPARATION_S) cutEnd = s.start - WORD_CUT_SEPARATION_S
    }

    const center = cutEnd - cutStart
    if (center < MIN_CENTER_S) { rec.drop_reason = 'guard_left_too_little_center'; droppedGuard++; per.push(rec); continue }

    rec.final_start = cutStart
    rec.final_end = cutEnd
    rec.kept = true
    per.push(rec)
    regions.push({ id: `betasil-${regions.length}`, start: cutStart, end: cutEnd, action: 'remove', protect: true })
  }

  const total = regions.reduce((n, r) => n + (r.end - r.start), 0)
  return {
    regions,
    debug: {
      retake_beta_vad_profile: { min_gap_s: minGap, speech_pad_ms: 220, edge_trim_ms: 0, remove_breaths: false },
      raw_vad_silence_regions: vadRegions.length,
      silence_regions_after_min_gap: afterMinGap,
      silence_regions_after_word_clamp: regions.length,
      silence_regions_dropped_too_short: droppedShort + droppedGuard,
      silence_regions_dropped_overlap_word_cut: droppedOverlap,
      silence_regions_dropped_due_to_guard: droppedGuard,
      final_retake_beta_silence_regions: regions.length,
      total_silence_removed_s: Number(total.toFixed(3)),
      per_region: per
    }
  }
}
