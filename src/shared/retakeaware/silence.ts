// Retake β — HYBRID, transcript-gap-driven silence cutter.
//
// The pause SPAN comes from the transcript word gaps (prev.end → next.start),
// which capture the FULL perceived pause. VAD is used ONLY as a safety check:
// it can shrink/drop a cut if there is real speech inside the proposed centre,
// but it NEVER decides the span and its under-detection can never cap how much
// silence we remove (that was the old VAD-only leniency bug). Cuts remove only
// the guarded CENTRE of the gap (never near either word), targeting a natural
// residual pause. Output is action:'remove', protect:true so computeKeepRanges
// applies it verbatim. PURE (the VAD scan itself runs in the engine).
//
// FastCut / ProCut are untouched — they keep their own aggressive Cut Lord VAD.
import type { SilenceRegion, SilenceDetectOptions } from '../types'
import type { VerbatimWord, CutSpan } from './types'

// ---- candidate + guard tuning ----
export const RETAKE_BETA_MIN_GAP_S = 0.85 // ignore transcript gaps under this
const MIN_REMOVED_S = 0.35 // drop if the cut would remove less than this
const LEFT_GUARD_S = 0.22 // previous word tail
const LEFT_GUARD_FRAGILE_S = 0.32
const RIGHT_GUARD_S = 0.28 // next word preroll
const RIGHT_GUARD_FRAGILE_S = 0.38
// A genuine speech island (silence-bounded on BOTH sides) this long INSIDE the
// proposed centre means the transcript missed a word/sound → drop. Edge/marginal
// VAD under-detection is NOT an interior island, so it never blocks a cut.
const VAD_INTERIOR_SPEECH_S = 0.35
// Keep the removable centre this far from any word cut, so the protected silence
// never bridges/eats speech with an adjacent retake cut (covers the word cut's
// own ±0.12s valley-snap + a 0.25s margin).
const WORD_CUT_SEP_S = 0.4
const FRAGILE = new Set([
  'i', 'it', 'a', 'an', 'and', 'but', 'so', 'the', 'to', 'is', 'was', 'has', 'have', 'in', 'on', 'of', 'or', 'uh', 'um'
])
const normWord = (w: string): string => w.toLowerCase().replace(/[^a-z']/g, '')

/** Natural residual pause to leave for a gap of this length (seconds). */
function targetResidual(gap: number): number {
  if (gap < 1.2) return 0.5 // clause beat
  if (gap < 2.5) return 0.55 // sentence
  if (gap < 5.0) return 0.65 // long
  return 0.8 // dead air
}

/** VAD options for the SAFETY scan only — fine-grained silence map (not the
 *  candidate source). speechPad keeps a little back from speech; minDuration
 *  small so genuine mid-pause speech shows up. */
export function retakeBetaVadSafetyOpts(): SilenceDetectOptions {
  return { mode: 'vad', noiseDb: -30, minDuration: 0.1, vadThreshold: 0.5, speechPadMs: 60, edgeTrimMs: 0, removeBreaths: false }
}

export interface VadInterval { start: number; end: number }

/** Largest interior speech island within [a,b]: a non-silent stretch bounded by
 *  VAD silence on BOTH sides (i.e. surrounded by silence, not at an edge). 0 if
 *  none, or if VAD gave < 2 silent chunks here (can't form an interior island). */
function largestInteriorSpeech(a: number, b: number, vad: VadInterval[]): number {
  const inside = vad
    .filter((s) => s.end > a && s.start < b)
    .map((s) => ({ start: Math.max(a, s.start), end: Math.min(b, s.end) }))
    .sort((x, y) => x.start - y.start)
  if (inside.length < 2) return 0
  let maxIsland = 0
  for (let i = 1; i < inside.length; i++) {
    const gs = inside[i - 1].end
    const ge = inside[i].start
    if (ge - gs > 0 && gs > a + 0.03 && ge < b - 0.03) maxIsland = Math.max(maxIsland, ge - gs)
  }
  return maxIsland
}

/** Total VAD-silent coverage of [a,b] (for debug provenance). */
function vadCoverage(a: number, b: number, vad: VadInterval[]): number {
  let cov = 0
  for (const s of vad) cov += Math.max(0, Math.min(b, s.end) - Math.max(a, s.start))
  return cov
}

export interface BetaSilenceDebugRegion {
  source: 'transcript_gap_hybrid'
  previous_word: string
  previous_word_start: number
  previous_word_end: number
  next_word: string
  next_word_start: number
  next_word_end: number
  transcript_gap_start: number
  transcript_gap_end: number
  transcript_gap_duration: number
  vad_silence_overlap: number
  proposed_cut_start: number | null
  proposed_cut_end: number | null
  final_cut_start: number | null
  final_cut_end: number | null
  left_guard_ms: number
  right_guard_ms: number
  target_residual_s: number
  effective_residual_s: number
  removed_s: number
  remaining_pause_s: number
  removal_ratio: number
  kept: boolean
  dropped_under_min_gap: boolean
  dropped_too_little_removed: boolean
  dropped_due_to_word_guard: boolean
  dropped_due_to_vad_speech_inside_center: boolean
  dropped_due_to_word_cut_overlap: boolean
}

export interface BetaSilenceResult {
  regions: SilenceRegion[]
  debug: {
    source: 'transcript_gap_hybrid'
    retake_beta_vad_profile: { min_gap_s: number; safety_vad: string; edge_trim_ms: number; remove_breaths: boolean }
    total_transcript_gaps_considered: number
    kept: number
    dropped_under_min_gap: number
    dropped_too_little_removed: number
    dropped_due_to_word_guard: number
    dropped_due_to_vad_speech_inside_center: number
    dropped_due_to_word_cut_overlap: number
    total_silence_removed_s: number
    per_region: BetaSilenceDebugRegion[]
  }
}

/** Hybrid detector. `vad` = VAD silence intervals (SAFETY only). PURE. */
export function detectBetaSilencesHybrid(
  words: VerbatimWord[],
  wordCutSpans: CutSpan[],
  vad: VadInterval[] = [],
  minGap: number = RETAKE_BETA_MIN_GAP_S
): BetaSilenceResult {
  const ms = (s: number): number => Math.round(s * 1000)
  const overlapsWordCut = (a: number, b: number): boolean => wordCutSpans.some((s) => a < s.end && s.start < b)
  const regions: SilenceRegion[] = []
  const per: BetaSilenceDebugRegion[] = []
  let considered = 0
  let dUnderMin = 0
  let dTooLittle = 0
  let dGuard = 0
  let dVad = 0
  let dOverlap = 0

  const base = (prev: VerbatimWord, next: VerbatimWord, gap: number, lg: number, rg: number, tr: number): BetaSilenceDebugRegion => ({
    source: 'transcript_gap_hybrid',
    previous_word: prev.word, previous_word_start: prev.start, previous_word_end: prev.end,
    next_word: next.word, next_word_start: next.start, next_word_end: next.end,
    transcript_gap_start: prev.end, transcript_gap_end: next.start, transcript_gap_duration: gap,
    vad_silence_overlap: 0,
    proposed_cut_start: null, proposed_cut_end: null, final_cut_start: null, final_cut_end: null,
    left_guard_ms: ms(lg), right_guard_ms: ms(rg), target_residual_s: tr, effective_residual_s: 0,
    removed_s: 0, remaining_pause_s: gap, removal_ratio: 0, kept: false,
    dropped_under_min_gap: false, dropped_too_little_removed: false, dropped_due_to_word_guard: false,
    dropped_due_to_vad_speech_inside_center: false, dropped_due_to_word_cut_overlap: false
  })

  for (let i = 0; i < words.length - 1; i++) {
    const prev = words[i]
    const next = words[i + 1]
    const gap = next.start - prev.end
    if (gap <= 0) continue
    considered++
    const prevFragile = FRAGILE.has(normWord(prev.word))
    const nextFragile = FRAGILE.has(normWord(next.word))
    const lg = prevFragile ? LEFT_GUARD_FRAGILE_S : LEFT_GUARD_S
    const rg = nextFragile ? RIGHT_GUARD_FRAGILE_S : RIGHT_GUARD_S
    const tr = targetResidual(gap)
    const rec = base(prev, next, gap, lg, rg, tr)

    // 1. breath / short-gap floor.
    if (gap < minGap) { rec.dropped_under_min_gap = true; dUnderMin++; per.push(rec); continue }
    // 2. guard zone, then carve it AWAY from any nearby word cut by WORD_CUT_SEP
    //    (so we never bridge/eat speech, but a real pause ADJACENT to a retake is
    //    still tightened — only a gap whose removable zone a cut fully swallows is
    //    dropped as overlap). This keeps sentence pauses next to dashed retakes.
    let g0 = prev.end + lg
    let g1 = next.start - rg
    for (const c of wordCutSpans) {
      if (c.end > prev.end && c.end < next.start) g0 = Math.max(g0, c.end + WORD_CUT_SEP_S)
      if (c.start < next.start && c.start > prev.end) g1 = Math.min(g1, c.start - WORD_CUT_SEP_S)
    }
    if (g1 <= g0) {
      if (overlapsWordCut(prev.end, next.start)) { rec.dropped_due_to_word_cut_overlap = true; dOverlap++ }
      else { rec.dropped_due_to_word_guard = true; dGuard++ }
      per.push(rec); continue
    }
    // 3. target: leave >= (guards) natural residual; remove the rest of the centre,
    //    but never more than the carved zone allows.
    const effResidual = Math.max(tr, lg + rg)
    const removed = Math.min(gap - effResidual, g1 - g0)
    rec.effective_residual_s = Number(effResidual.toFixed(3))
    if (removed < MIN_REMOVED_S) {
      if (g1 - g0 < gap - lg - rg - 0.01) { rec.dropped_due_to_word_cut_overlap = true; dOverlap++ }
      else { rec.dropped_too_little_removed = true; dTooLittle++ }
      per.push(rec); continue
    }
    // 4. centre the removed slice inside the (carved) guard zone.
    const zoneMid = (g0 + g1) / 2
    let cutStart = zoneMid - removed / 2
    let cutEnd = zoneMid + removed / 2
    cutStart = Math.max(cutStart, g0)
    cutEnd = Math.min(cutEnd, g1)
    rec.proposed_cut_start = cutStart
    rec.proposed_cut_end = cutEnd
    rec.vad_silence_overlap = Number(vadCoverage(cutStart, cutEnd, vad).toFixed(3))
    // 6. VAD SAFETY: a genuine speech island inside the centre → drop (never let
    //    VAD *under*-detection cap us — only a silence-bounded interior island counts).
    if (largestInteriorSpeech(cutStart, cutEnd, vad) >= VAD_INTERIOR_SPEECH_S) {
      rec.dropped_due_to_vad_speech_inside_center = true
      dVad++
      per.push(rec)
      continue
    }
    // keep
    const finalRemoved = cutEnd - cutStart
    rec.final_cut_start = cutStart
    rec.final_cut_end = cutEnd
    rec.removed_s = Number(finalRemoved.toFixed(3))
    rec.remaining_pause_s = Number((gap - finalRemoved).toFixed(3))
    rec.removal_ratio = Number((finalRemoved / gap).toFixed(3))
    rec.kept = true
    per.push(rec)
    regions.push({ id: `betasil-${regions.length}`, start: cutStart, end: cutEnd, action: 'remove', protect: true })
  }

  const total = regions.reduce((n, r) => n + (r.end - r.start), 0)
  return {
    regions,
    debug: {
      source: 'transcript_gap_hybrid',
      retake_beta_vad_profile: { min_gap_s: minGap, safety_vad: 'vad@0.1s minDur, 60ms pad (safety only)', edge_trim_ms: 0, remove_breaths: false },
      total_transcript_gaps_considered: considered,
      kept: regions.length,
      dropped_under_min_gap: dUnderMin,
      dropped_too_little_removed: dTooLittle,
      dropped_due_to_word_guard: dGuard,
      dropped_due_to_vad_speech_inside_center: dVad,
      dropped_due_to_word_cut_overlap: dOverlap,
      total_silence_removed_s: Number(total.toFixed(3)),
      per_region: per
    }
  }
}
