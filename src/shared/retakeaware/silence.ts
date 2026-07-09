// Retake β — HYBRID, transcript-gap-driven silence cutter (Retake β ONLY).
//
// The pause SPAN comes from the transcript word gaps (the full perceived pause);
// VAD is a safety check only (drops a cut if real speech sits inside the centre),
// never the span. Cuts remove only the guarded CENTRE, target a natural residual,
// and are emitted action:'remove', protect:true so computeKeepRanges applies them
// verbatim + ripple-closes. All behaviour is driven by RetakeBetaSilenceSettings
// so the Retake β "Silence Settings" UI can tune it WITHOUT touching FastCut/ProCut.
import type { SilenceRegion, SilenceDetectOptions } from '../types'
import type { VerbatimWord, CutSpan } from './types'

// ---- user-tunable settings (Retake β silence detection only) ----
export type SilencePreset = 'conservative' | 'balanced' | 'aggressive' | 'custom'
export interface RetakeBetaSilenceSettings {
  preset: SilencePreset
  minPauseS: number // ignore transcript gaps under this
  targetRemainingS: number // target residual pause left after a cut
  paddingBeforeS: number // left guard (previous word tail)
  paddingAfterS: number // right guard (next word preroll)
  minRemovedS: number // drop if the cut removes less than this
  removeBreaths: boolean // OFF for launch
  maxCutsPerMinute: number // density cap (drops weakest over the limit)
  antiSliver: boolean // ON: never leave a <0.5s isolated timeline clip
}
export const RETAKE_BETA_SILENCE_PRESETS: Record<Exclude<SilencePreset, 'custom'>, Omit<RetakeBetaSilenceSettings, 'preset'>> = {
  conservative: { minPauseS: 1.5, targetRemainingS: 0.7, paddingBeforeS: 0.3, paddingAfterS: 0.38, minRemovedS: 0.8, removeBreaths: false, maxCutsPerMinute: 4, antiSliver: true },
  balanced: { minPauseS: 1.2, targetRemainingS: 0.55, paddingBeforeS: 0.25, paddingAfterS: 0.32, minRemovedS: 0.65, removeBreaths: false, maxCutsPerMinute: 6, antiSliver: true },
  aggressive: { minPauseS: 0.85, targetRemainingS: 0.4, paddingBeforeS: 0.2, paddingAfterS: 0.25, minRemovedS: 0.45, removeBreaths: false, maxCutsPerMinute: 10, antiSliver: true }
}
/** Launch default: Balanced, safe (no breath removal, anti-sliver ON). */
export const DEFAULT_RETAKE_BETA_SILENCE_SETTINGS: RetakeBetaSilenceSettings = { preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced }

// A resulting timeline clip shorter than this (created only by silence) is a
// useless sliver — the cut is merged/rejected so the timeline ripple-closes clean.
const ANTI_SLIVER_S = 0.5
// Fragile short words clip easily → floor the guard for them.
const FRAGILE = new Set(['i', 'it', 'a', 'an', 'and', 'but', 'so', 'the', 'to', 'is', 'was', 'has', 'have', 'in', 'on', 'of', 'or', 'uh', 'um'])
const FRAGILE_LEFT_FLOOR = 0.32
const FRAGILE_RIGHT_FLOOR = 0.38
const VAD_INTERIOR_SPEECH_S = 0.35
const normWord = (w: string): string => w.toLowerCase().replace(/[^a-z']/g, '')

export function retakeBetaVadSafetyOpts(): SilenceDetectOptions {
  return { mode: 'vad', noiseDb: -30, minDuration: 0.1, vadThreshold: 0.5, speechPadMs: 60, edgeTrimMs: 0, removeBreaths: false }
}

export interface VadInterval { start: number; end: number }

function largestInteriorSpeech(a: number, b: number, vad: VadInterval[]): number {
  const inside = vad.filter((s) => s.end > a && s.start < b).map((s) => ({ start: Math.max(a, s.start), end: Math.min(b, s.end) })).sort((x, y) => x.start - y.start)
  if (inside.length < 2) return 0
  let max = 0
  for (let i = 1; i < inside.length; i++) {
    const gs = inside[i - 1].end
    const ge = inside[i].start
    if (ge - gs > 0 && gs > a + 0.03 && ge < b - 0.03) max = Math.max(max, ge - gs)
  }
  return max
}
function vadCoverage(a: number, b: number, vad: VadInterval[]): number {
  let cov = 0
  for (const s of vad) cov += Math.max(0, Math.min(b, s.end) - Math.max(a, s.start))
  return cov
}
// AssemblyAI sometimes ABSORBS trailing silence into a word's end time (a "word"
// spanning 2–4s) — the transcript gap then reads ~0 and the silence rides along
// INSIDE the clip ("noise left in, seen as voice"). VAD tells us where the audio
// actually goes quiet, so refine the word's true speech end/start. Only trims when
// VAD silence covers the word's tail/head; a normal word (no trailing silence) is
// unchanged. With no VAD, returns the raw boundary (transcript-only fallback).
function vadSpeechEnd(w: { start: number; end: number }, vad: VadInterval[]): number {
  let end = w.end
  for (const s of vad) {
    if (s.start > w.start + 0.05 && s.start < w.end - 0.02 && s.end >= w.end - 0.1) end = Math.min(end, s.start)
  }
  return end
}
function vadSpeechStart(w: { start: number; end: number }, vad: VadInterval[]): number {
  let start = w.start
  for (const s of vad) {
    if (s.end < w.end - 0.05 && s.end > w.start + 0.02 && s.start <= w.start + 0.1) start = Math.max(start, s.end)
  }
  return start
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
  merged_with_word_cut: boolean
  rejected_due_to_sliver: boolean
  rejected_due_to_min_removed: boolean
  rejected_due_to_word_guard: boolean
  rejected_due_to_vad_speech_inside_center: boolean
  rejected_due_to_word_cut_overlap: boolean
  rejected_due_to_cut_density: boolean
  rejected_due_to_timeline_micro_clip: boolean
  dropped_under_min_gap: boolean
}

export interface BetaSilenceResult {
  regions: SilenceRegion[]
  debug: {
    source: 'transcript_gap_hybrid'
    retake_beta_silence_settings_used: {
      preset: SilencePreset
      min_pause_s: number
      target_remaining_pause_s: number
      speech_padding_before_s: number
      speech_padding_after_s: number
      min_removed_s: number
      remove_breaths: boolean
      max_cuts_per_minute: number
      anti_sliver_protection: boolean
    }
    total_transcript_gaps_considered: number
    kept: number
    dropped_under_min_gap: number
    rejected_due_to_min_removed: number
    rejected_due_to_vad_speech_inside_center: number
    rejected_due_to_word_cut_overlap: number
    rejected_due_to_sliver: number
    rejected_due_to_cut_density: number
    rejected_due_to_timeline_micro_clip: number
    merged_with_word_cut: number
    final_silence_regions_staged: number
    total_silence_removed_s: number
    per_region: BetaSilenceDebugRegion[]
  }
}

export function detectBetaSilencesHybrid(
  words: VerbatimWord[],
  wordCutSpans: CutSpan[],
  vad: VadInterval[] = [],
  settings: RetakeBetaSilenceSettings = DEFAULT_RETAKE_BETA_SILENCE_SETTINGS,
  totalDurationS = 0
): BetaSilenceResult {
  const ms = (s: number): number => Math.round(s * 1000)
  const overlapsWordCut = (a: number, b: number): boolean => wordCutSpans.some((s) => a < s.end && s.start < b)
  const hasKeptWord = (a: number, b: number): boolean =>
    words.some((w) => { const m = (w.start + w.end) / 2; return m > a + 0.001 && m < b - 0.001 && !wordCutSpans.some((s) => m >= s.start && m <= s.end) })

  const per: BetaSilenceDebugRegion[] = []
  const kept: { rec: BetaSilenceDebugRegion; cutStart: number; cutEnd: number }[] = []
  let considered = 0, dUnderMin = 0, dMinRemoved = 0, dVad = 0, dOverlap = 0, dSliver = 0, merged = 0

  for (let i = 0; i < words.length - 1; i++) {
    const prev = words[i], next = words[i + 1]
    // TRUE speech boundaries: VAD-refined so silence AssemblyAI hid inside an
    // over-long word (its end padded through the pause) is exposed as real gap.
    const pEnd = vadSpeechEnd(prev, vad)
    const nStart = vadSpeechStart(next, vad)
    const gap = nStart - pEnd
    if (gap <= 0) continue
    considered++
    const lg = FRAGILE.has(normWord(prev.word)) ? Math.max(settings.paddingBeforeS, FRAGILE_LEFT_FLOOR) : settings.paddingBeforeS
    const rg = FRAGILE.has(normWord(next.word)) ? Math.max(settings.paddingAfterS, FRAGILE_RIGHT_FLOOR) : settings.paddingAfterS
    const rec: BetaSilenceDebugRegion = {
      source: 'transcript_gap_hybrid',
      previous_word: prev.word, previous_word_start: prev.start, previous_word_end: prev.end,
      next_word: next.word, next_word_start: next.start, next_word_end: next.end,
      transcript_gap_start: Number(pEnd.toFixed(3)), transcript_gap_end: Number(nStart.toFixed(3)), transcript_gap_duration: Number(gap.toFixed(3)),
      vad_silence_overlap: 0, proposed_cut_start: null, proposed_cut_end: null, final_cut_start: null, final_cut_end: null,
      left_guard_ms: ms(lg), right_guard_ms: ms(rg), target_residual_s: settings.targetRemainingS, effective_residual_s: 0,
      removed_s: 0, remaining_pause_s: Number(gap.toFixed(3)), removal_ratio: 0, kept: false,
      merged_with_word_cut: false, rejected_due_to_sliver: false, rejected_due_to_min_removed: false,
      rejected_due_to_word_guard: false, rejected_due_to_vad_speech_inside_center: false,
      rejected_due_to_word_cut_overlap: false, rejected_due_to_cut_density: false,
      rejected_due_to_timeline_micro_clip: false, dropped_under_min_gap: false
    }
    if (gap < settings.minPauseS) { rec.dropped_under_min_gap = true; dUnderMin++; per.push(rec); continue }

    const g0 = pEnd + lg
    const g1 = nStart - rg
    if (g1 <= g0) { rec.rejected_due_to_word_guard = true; dOverlap++; per.push(rec); continue }
    const effResidual = Math.max(settings.targetRemainingS, lg + rg)
    rec.effective_residual_s = Number(effResidual.toFixed(3))
    const removed0 = Math.min(gap - effResidual, g1 - g0)
    if (removed0 < settings.minRemovedS) { rec.rejected_due_to_min_removed = true; dMinRemoved++; per.push(rec); continue }
    const zoneMid = (g0 + g1) / 2
    let cutStart = Math.max(g0, zoneMid - removed0 / 2)
    let cutEnd = Math.min(g1, zoneMid + removed0 / 2)
    rec.proposed_cut_start = Number(cutStart.toFixed(3))
    rec.proposed_cut_end = Number(cutEnd.toFixed(3))

    // overlap with a word cut → drop (the pause is inside removed content).
    if (overlapsWordCut(cutStart, cutEnd)) { rec.rejected_due_to_word_cut_overlap = true; dOverlap++; per.push(rec); continue }

    // VAD SAFETY: a silence-bounded interior speech island → drop (missed word).
    rec.vad_silence_overlap = Number(vadCoverage(cutStart, cutEnd, vad).toFixed(3))
    if (largestInteriorSpeech(cutStart, cutEnd, vad) >= VAD_INTERIOR_SPEECH_S) { rec.rejected_due_to_vad_speech_inside_center = true; dVad++; per.push(rec); continue }

    // ANTI-SLIVER: if a word cut sits within <0.5s of this cut with only AIR
    // between (no kept word), swallow that air so the timeline ripple-closes with
    // no micro-clip; if the gap holds speech, keep the separation (never eat it).
    if (settings.antiSliver) {
      for (const c of wordCutSpans) {
        if (c.end <= cutStart && cutStart - c.end < ANTI_SLIVER_S && !hasKeptWord(c.end, cutStart)) { cutStart = c.end; rec.merged_with_word_cut = true }
        if (c.start >= cutEnd && c.start - cutEnd < ANTI_SLIVER_S && !hasKeptWord(cutEnd, c.start)) { cutEnd = c.start; rec.merged_with_word_cut = true }
      }
      if (rec.merged_with_word_cut) merged++
    }

    rec.final_cut_start = Number(cutStart.toFixed(3))
    rec.final_cut_end = Number(cutEnd.toFixed(3))
    rec.removed_s = Number((cutEnd - cutStart).toFixed(3))
    rec.remaining_pause_s = Number((gap - (cutEnd - cutStart)).toFixed(3))
    rec.removal_ratio = Number(((cutEnd - cutStart) / gap).toFixed(3))
    rec.kept = true
    per.push(rec)
    kept.push({ rec, cutStart, cutEnd })
  }

  // DENSITY CAP: if more cuts than maxCutsPerMinute allows, drop the weakest.
  let dDensity = 0
  const minutes = Math.max(1 / 60, totalDurationS / 60)
  const maxCuts = Math.max(1, Math.floor(settings.maxCutsPerMinute * minutes))
  let active = kept
  if (kept.length > maxCuts) {
    const byStrength = [...kept].sort((a, b) => (b.cutEnd - b.cutStart) - (a.cutEnd - a.cutStart))
    const survivors = new Set(byStrength.slice(0, maxCuts))
    for (const k of kept) if (!survivors.has(k)) { k.rec.kept = false; k.rec.final_cut_start = null; k.rec.final_cut_end = null; k.rec.rejected_due_to_cut_density = true; dDensity++ }
    active = kept.filter((k) => survivors.has(k))
  }

  active.sort((a, b) => a.cutStart - b.cutStart)
  const regions: SilenceRegion[] = active.map((k, i) => ({ id: `betasil-${i}`, start: k.cutStart, end: k.cutEnd, action: 'remove' as const, protect: true }))
  const total = regions.reduce((n, r) => n + (r.end - r.start), 0)
  return {
    regions,
    debug: {
      source: 'transcript_gap_hybrid',
      retake_beta_silence_settings_used: {
        preset: settings.preset,
        min_pause_s: settings.minPauseS, target_remaining_pause_s: settings.targetRemainingS,
        speech_padding_before_s: settings.paddingBeforeS, speech_padding_after_s: settings.paddingAfterS,
        min_removed_s: settings.minRemovedS, remove_breaths: settings.removeBreaths,
        max_cuts_per_minute: settings.maxCutsPerMinute, anti_sliver_protection: settings.antiSliver
      },
      total_transcript_gaps_considered: considered,
      kept: regions.length,
      dropped_under_min_gap: dUnderMin,
      rejected_due_to_min_removed: dMinRemoved,
      rejected_due_to_vad_speech_inside_center: dVad,
      rejected_due_to_word_cut_overlap: dOverlap,
      rejected_due_to_sliver: dSliver,
      rejected_due_to_cut_density: dDensity,
      rejected_due_to_timeline_micro_clip: 0,
      merged_with_word_cut: merged,
      final_silence_regions_staged: regions.length,
      total_silence_removed_s: Number(total.toFixed(3)),
      per_region: per
    }
  }
}
