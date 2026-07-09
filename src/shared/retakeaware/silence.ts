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
// Detect no-transcript islands down to this floor so short record-button clicks
// (typically 0.1–0.4s) are classified + logged, not silently cut through. The
// classifier (not this floor) decides keep-vs-remove; protection needs ≥ 0.75s.
const ISLAND_DETECT_MIN_S = 0.08
// Lead-in kept BEFORE the next word's true onset. The residual is split
// asymmetrically: a small tight lead-in here (a clip should start ~immediately),
// and the rest as trailing air after the previous word. Only this tight when VAD
// pins the true onset; without VAD we fall back to the full right guard so a
// late transcript onset can't clip the word.
const RIGHT_LEAD_S = 0.1
// ---- no-transcript noise-island classifier (record-button clicks, taps, mouth /
// breath / handling noise). Transcript words are the SOURCE OF TRUTH for speech: a
// VAD island with no transcript word is NOT automatically protected. ----
const NOISE_CLICK_MAX_S = 0.6 // a no-transcript island this short is a click/tap → remove
const SPEECH_ISLAND_MIN_S = 0.75 // this long (and not a sharp transient) → likely missed speech → protect
const EDGE_PREROLL_S = 0.25 // safe pre-roll kept before the first real word when trimming a leading click
const normWord = (w: string): string => w.toLowerCase().replace(/[^a-z']/g, '')

export type IslandClassification = 'protected_speech' | 'likely_noise_click' | 'likely_breath_noise' | 'uncertain'
export interface NoTranscriptIslandDebug {
  start: number
  end: number
  duration: number
  where: 'transcript_gap' | 'leading_edge' | 'trailing_edge' | 'lead_guard' | 'trail_guard'
  nearest_previous_word: string
  nearest_previous_word_end: number
  nearest_next_word: string
  nearest_next_word_start: number
  transcript_words_inside_count: number
  peak_rms_ratio: number | null
  energy_vs_noise_floor: number | null
  classification: IslandClassification
  decision: 'keep' | 'remove'
  reason: string
}
/** Classify a VAD island / kept audio segment that has NO transcript word overlapping
 *  it. Short isolated noises (clicks, taps, mouth/breath/handling noise) are removed;
 *  only a long, speech-like island is protected as possible missed speech. Optional
 *  RMS features refine the call; the duration bands are the primary signal without
 *  them (a click is short, missed speech is sustained). */
function classifyNoTranscriptIsland(durationS: number, rms?: { peakRatio?: number | null; energyVsFloor?: number | null }): { classification: IslandClassification; decision: 'keep' | 'remove'; reason: string } {
  const sharpTransient = rms?.peakRatio != null && rms.peakRatio >= 6 // a spike, not sustained speech
  const speechEnergy = rms?.energyVsFloor != null && rms.energyVsFloor >= 3 // sustained energy well above floor
  // STRONG evidence of missed speech → protect.
  if (durationS >= SPEECH_ISLAND_MIN_S && !sharpTransient) return { classification: 'protected_speech', decision: 'keep', reason: `duration ${durationS.toFixed(2)}s ≥ ${SPEECH_ISLAND_MIN_S}s and not a sharp transient — likely missed speech` }
  if (speechEnergy && durationS >= NOISE_CLICK_MAX_S) return { classification: 'protected_speech', decision: 'keep', reason: `sustained speech-like energy (${rms!.energyVsFloor!.toFixed(1)}× floor) over ${durationS.toFixed(2)}s` }
  // NOISE → remove.
  if (durationS <= NOISE_CLICK_MAX_S) {
    const breath = rms?.peakRatio != null && rms.peakRatio < 3 // soft, no sharp onset
    return { classification: breath ? 'likely_breath_noise' : 'likely_noise_click', decision: 'remove', reason: `short ${durationS.toFixed(2)}s ≤ ${NOISE_CLICK_MAX_S}s no-transcript island — ${breath ? 'breath/handling noise' : 'click/tap'}, no recognized word` }
  }
  return { classification: 'uncertain', decision: 'remove', reason: `no-transcript island ${durationS.toFixed(2)}s (${NOISE_CLICK_MAX_S}–${SPEECH_ISLAND_MIN_S}s) — would be a standalone wordless clip, removing` }
}
/** Largest contiguous NON-silence (speech/noise) span in [a,b], edges included — the
 *  complement of the VAD silence intervals. Used to classify leading/trailing edge
 *  noise (interiorSpeechIslands excludes the edges, so a click AT the start is missed
 *  by it). Returns b−a when there is no VAD (can't tell). */
function largestNonSilence(a: number, b: number, vad: VadInterval[]): number {
  if (vad.length === 0) return b - a
  const sils = vad.filter((s) => s.end > a && s.start < b).map((s) => ({ start: Math.max(a, s.start), end: Math.min(b, s.end) })).sort((x, y) => x.start - y.start)
  let max = 0, cursor = a
  for (const s of sils) { if (s.start - cursor > max) max = s.start - cursor; cursor = Math.max(cursor, s.end) }
  if (b - cursor > max) max = b - cursor
  return max
}
/** Non-silence (speech/noise) blobs within [a,b] — the complement of the VAD silence
 *  intervals, edges included. Used to find a click sitting in a word's kept guard
 *  air. Empty when there is no VAD or the window collapses. */
function nonSilenceBlobs(a: number, b: number, vad: VadInterval[]): VadInterval[] {
  if (vad.length === 0 || b - a <= 0.02) return []
  const sils = vad.filter((s) => s.end > a && s.start < b).map((s) => ({ start: Math.max(a, s.start), end: Math.min(b, s.end) })).sort((x, y) => x.start - y.start)
  const blobs: VadInterval[] = []
  let cursor = a
  for (const s of sils) { if (s.start - cursor > 0.02) blobs.push({ start: cursor, end: s.start }); cursor = Math.max(cursor, s.end) }
  if (b - cursor > 0.02) blobs.push({ start: cursor, end: b })
  return blobs
}

export function retakeBetaVadSafetyOpts(): SilenceDetectOptions {
  return { mode: 'vad', noiseDb: -30, minDuration: 0.1, vadThreshold: 0.5, speechPadMs: 60, edgeTrimMs: 0, removeBreaths: false }
}

export interface VadInterval { start: number; end: number }

/** All silence-bounded interior SPEECH islands within (a,b): the spans BETWEEN
 *  consecutive VAD silence intervals (i.e. what VAD marks as voice), each strictly
 *  interior (not touching a/b) and ≥ minLen. In a transcript GAP these are possible
 *  transcript-missed words — we carve the removable silence AROUND them instead of
 *  cutting straight through (or dropping the whole cut and leaving dead air). */
function interiorSpeechIslands(a: number, b: number, vad: VadInterval[], minLen: number): VadInterval[] {
  const inside = vad.filter((s) => s.end > a && s.start < b).map((s) => ({ start: Math.max(a, s.start), end: Math.min(b, s.end) })).sort((x, y) => x.start - y.start)
  const islands: VadInterval[] = []
  for (let i = 1; i < inside.length; i++) {
    const gs = inside[i - 1].end, ge = inside[i].start
    if (ge - gs >= minLen && gs > a + 0.03 && ge < b - 0.03) islands.push({ start: gs, end: ge })
  }
  return islands
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
/** TRUE onset of speech before `nextStart`: the end of the VAD silence region
 *  that runs up to (near) the next word. May be EARLIER than nextStart when the
 *  transcript onset is late — so cutting to (onset − 100ms) never clips. null if
 *  VAD gives no clear silence there → caller keeps the safe guard instead. */
function vadOnset(nextStart: number, vad: VadInterval[]): number | null {
  let onset: number | null = null
  for (const s of vad) {
    if (s.end - s.start >= 0.1 && s.end <= nextStart + 0.05 && s.end >= nextStart - 0.6) {
      onset = onset == null ? s.end : Math.max(onset, s.end)
    }
  }
  return onset
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
  // Set when a VAD-flagged interior speech island (possible transcript-missed word)
  // was found in the gap: the islands preserved, and (if the cut was split around
  // them) the resulting sub-cuts. Absent on a normal single-span cut.
  carved_around_speech_islands?: { start: number; end: number }[]
  carve_cuts?: { start: number; end: number }[]
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
    carved_around_speech_islands: number
    rejected_due_to_vad_speech_inside_center: number
    rejected_due_to_word_cut_overlap: number
    rejected_due_to_sliver: number
    rejected_due_to_cut_density: number
    rejected_due_to_timeline_micro_clip: number
    merged_with_word_cut: number
    // no-transcript noise-island classifier: short clicks/taps/breath removed,
    // only long speech-like islands protected. Every classified island is logged.
    noise_islands_removed: number
    speech_islands_protected: number
    no_transcript_islands: NoTranscriptIslandDebug[]
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
  const noTranscriptIslands: NoTranscriptIslandDebug[] = []
  let considered = 0, dUnderMin = 0, dMinRemoved = 0, dVad = 0, dOverlap = 0, dSliver = 0, merged = 0, carvedCount = 0
  let noiseRemoved = 0, speechProtected = 0
  const logIsland = (start: number, end: number, where: NoTranscriptIslandDebug['where'], prevW: string, prevEnd: number, nextW: string, nextStart: number, cls: { classification: IslandClassification; decision: 'keep' | 'remove'; reason: string }): void => {
    noTranscriptIslands.push({
      start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), duration: Number((end - start).toFixed(3)), where,
      nearest_previous_word: prevW, nearest_previous_word_end: Number(prevEnd.toFixed(3)),
      nearest_next_word: nextW, nearest_next_word_start: Number(nextStart.toFixed(3)),
      transcript_words_inside_count: 0, peak_rms_ratio: null, energy_vs_noise_floor: null,
      classification: cls.classification, decision: cls.decision, reason: cls.reason
    })
    if (cls.decision === 'remove') noiseRemoved++; else speechProtected++
  }

  for (let i = 0; i < words.length - 1; i++) {
    const prev = words[i], next = words[i + 1]
    // TRUE speech boundaries: VAD-refined so silence AssemblyAI hid inside an
    // over-long word (its end padded through the pause) is exposed as real gap.
    const pEnd = vadSpeechEnd(prev, vad)
    const onsetVad = vadOnset(next.start, vad)
    const nStart = onsetVad != null ? onsetVad : vadSpeechStart(next, vad) // true onset (may precede transcript start)
    const gap = nStart - pEnd
    if (gap <= 0) continue
    considered++
    const lg = FRAGILE.has(normWord(prev.word)) ? Math.max(settings.paddingBeforeS, FRAGILE_LEFT_FLOOR) : settings.paddingBeforeS
    const rgFull = FRAGILE.has(normWord(next.word)) ? Math.max(settings.paddingAfterS, FRAGILE_RIGHT_FLOOR) : settings.paddingAfterS
    // Lead-in (residual before the next word): tight 100ms when VAD pins the onset,
    // else the full guard (so a late transcript onset can't clip). Trailing air
    // after the previous word keeps the rest of the residual (user likes trailing).
    const rg = onsetVad != null ? Math.min(RIGHT_LEAD_S, rgFull) : rgFull
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
    // ASYMMETRIC residual: cut ends a tight lead-in (rg, ~100ms with VAD) before
    // the next word's onset; the rest of the residual stays as trailing air after
    // the previous word (which the user wants kept).
    let cutEnd = g1
    let cutStart = Math.max(g0, cutEnd - removed0)
    // VAD-SILENT GUARDS: a record-button click / tap can ride along in the kept
    // guard air right beside a word — the word's speech already ended at pEnd /
    // starts at nStart, so any NON-silence in the guard is noise, never the word.
    // Swallow such a blob into the cut so it isn't left glued to an isolated word
    // (e.g. a lone "Do"). Long non-silence (≥0.75s, possible missed speech) is
    // protected — only a short click is trimmed.
    if (vad.length) {
      const trail = nonSilenceBlobs(pEnd, cutStart, vad)[0] // click right after the previous word
      if (trail) {
        const cls = classifyNoTranscriptIsland(trail.end - trail.start)
        logIsland(trail.start, trail.end, 'trail_guard', prev.word, pEnd, next.word, nStart, cls)
        if (cls.decision === 'remove') cutStart = Math.max(pEnd, trail.start)
      }
      const leadBlobs = nonSilenceBlobs(cutEnd, nStart, vad)
      const lead = leadBlobs[leadBlobs.length - 1] // click right before the next word
      if (lead) {
        const cls = classifyNoTranscriptIsland(lead.end - lead.start)
        logIsland(lead.start, lead.end, 'lead_guard', prev.word, pEnd, next.word, nStart, cls)
        if (cls.decision === 'remove') cutEnd = Math.min(nStart, lead.end)
      }
    }
    rec.proposed_cut_start = Number(cutStart.toFixed(3))
    rec.proposed_cut_end = Number(cutEnd.toFixed(3))

    // VAD SAFETY → CARVE (not drop): a silence-bounded interior speech island is a
    // possible transcript-missed word. DROPPING the whole cut (the old behaviour)
    // left the entire long pause as dead air — a 4.7s gap with a ~1s mumble/breath
    // in the middle survived intact ("just silence, not cut"). Instead CARVE the
    // removable silence AROUND each island: cut the dead air on both sides, holding
    // a small guard so the island's audio isn't clipped. In a transcript gap the
    // island carries no word, so computeKeepRanges' wordless-residue drop rides over
    // it — the dead air goes; a genuinely-real missed word would surface as two
    // review chips hugging it. Full reject only if no side has enough silence left.
    rec.vad_silence_overlap = Number(vadCoverage(cutStart, cutEnd, vad).toFixed(3))
    // Classify every no-transcript VAD island in the cut. Transcript words are the
    // source of truth: a wordless island is NOT auto-protected. Short clicks/taps/
    // breath are CUT THROUGH (removed with the surrounding silence); only a long,
    // speech-like island is carved AROUND (kept as possible missed speech).
    const candidateIslands = interiorSpeechIslands(cutStart, cutEnd, vad, ISLAND_DETECT_MIN_S)
    const protectedIslands: VadInterval[] = []
    for (const isl of candidateIslands) {
      const cls = classifyNoTranscriptIsland(isl.end - isl.start)
      logIsland(isl.start, isl.end, 'transcript_gap', prev.word, pEnd, next.word, nStart, cls)
      if (cls.decision === 'keep') protectedIslands.push(isl)
    }
    let intervals: { s: number; e: number }[]
    if (protectedIslands.length) {
      const islandGuard = Math.max(0.15, Math.min(lg, rgFull)) // don't clip the island's speech
      intervals = []
      let seg = cutStart
      for (const isl of protectedIslands) {
        if (isl.start - islandGuard - seg >= settings.minRemovedS) intervals.push({ s: seg, e: isl.start - islandGuard })
        seg = isl.end + islandGuard
      }
      if (cutEnd - seg >= settings.minRemovedS) intervals.push({ s: seg, e: cutEnd })
      rec.carved_around_speech_islands = protectedIslands.map((i) => ({ start: Number(i.start.toFixed(3)), end: Number(i.end.toFixed(3)) }))
      if (!intervals.length) { rec.rejected_due_to_vad_speech_inside_center = true; dVad++; per.push(rec); continue }
      carvedCount++
    } else {
      // no protected island → cut straight through (removes any noise islands too).
      intervals = [{ s: cutStart, e: cutEnd }]
    }

    // ANTI-SLIVER + word-cut overlap, per resulting interval (a carve yields >1). A
    // sub-span inside removed content is skipped; air within <0.5s of a word cut
    // (no kept word between) is swallowed so the timeline ripple-closes clean.
    const committed: { s: number; e: number }[] = []
    for (const iv of intervals) {
      let cs = iv.s, ce = iv.e
      if (overlapsWordCut(cs, ce)) continue // the pause is inside removed content
      if (settings.antiSliver) {
        for (const c of wordCutSpans) {
          if (c.end <= cs && cs - c.end < ANTI_SLIVER_S && !hasKeptWord(c.end, cs)) { cs = c.end; rec.merged_with_word_cut = true }
          if (c.start >= ce && c.start - ce < ANTI_SLIVER_S && !hasKeptWord(ce, c.start)) { ce = c.start; rec.merged_with_word_cut = true }
        }
      }
      committed.push({ s: cs, e: ce })
    }
    if (!committed.length) { rec.rejected_due_to_word_cut_overlap = true; dOverlap++; per.push(rec); continue }
    if (rec.merged_with_word_cut) merged++

    const removedTotal = committed.reduce((n, c) => n + (c.e - c.s), 0)
    rec.final_cut_start = Number(committed[0].s.toFixed(3))
    rec.final_cut_end = Number(committed[committed.length - 1].e.toFixed(3))
    if (committed.length > 1) rec.carve_cuts = committed.map((c) => ({ start: Number(c.s.toFixed(3)), end: Number(c.e.toFixed(3)) }))
    rec.removed_s = Number(removedTotal.toFixed(3))
    rec.remaining_pause_s = Number((gap - removedTotal).toFixed(3))
    rec.removal_ratio = Number((removedTotal / gap).toFixed(3))
    rec.kept = true
    per.push(rec)
    for (const c of committed) kept.push({ rec, cutStart: c.s, cutEnd: c.e })
  }

  // ---- LEADING / TRAILING edge silence + noise (dead air / record-button click
  // before the first word, handling noise after the last). No bounding word on one
  // side, so it is all no-transcript audio. Trim it down to a safe pre-roll / tail:
  // remove pure silence AND short noise (a click/tap), but PROTECT a long non-silent
  // island (a music intro, an outro, or genuinely missed speech ≥ SPEECH_ISLAND_MIN).
  // No VAD → fall back to the old silence-trim (can't classify). ----
  const edgeMin = Math.min(settings.minPauseS, 0.7)
  const edgeRemovable = (a: number, b: number): boolean => b - a > 0.02 && (vad.length === 0 || largestNonSilence(a, b, vad) < SPEECH_ISLAND_MIN_S)
  const mkEdge = (prevW: string, nextW: string, gapStart: number, gapEnd: number, lg: number, rg: number): BetaSilenceDebugRegion => ({
    source: 'transcript_gap_hybrid',
    previous_word: prevW, previous_word_start: gapStart, previous_word_end: gapStart,
    next_word: nextW, next_word_start: gapEnd, next_word_end: gapEnd,
    transcript_gap_start: Number(gapStart.toFixed(3)), transcript_gap_end: Number(gapEnd.toFixed(3)), transcript_gap_duration: Number((gapEnd - gapStart).toFixed(3)),
    vad_silence_overlap: Number(vadCoverage(gapStart, gapEnd, vad).toFixed(3)), proposed_cut_start: null, proposed_cut_end: null, final_cut_start: null, final_cut_end: null,
    left_guard_ms: ms(lg), right_guard_ms: ms(rg), target_residual_s: settings.targetRemainingS, effective_residual_s: 0,
    removed_s: 0, remaining_pause_s: Number((gapEnd - gapStart).toFixed(3)), removal_ratio: 0, kept: false,
    merged_with_word_cut: false, rejected_due_to_sliver: false, rejected_due_to_min_removed: false,
    rejected_due_to_word_guard: false, rejected_due_to_vad_speech_inside_center: false,
    rejected_due_to_word_cut_overlap: false, rejected_due_to_cut_density: false,
    rejected_due_to_timeline_micro_clip: false, dropped_under_min_gap: false
  })
  const tryEdge = (rec: BetaSilenceDebugRegion, cs: number, ce: number): void => {
    considered++
    const rem = ce - cs
    if (rec.transcript_gap_duration < edgeMin) { rec.dropped_under_min_gap = true; dUnderMin++; per.push(rec); return }
    rec.proposed_cut_start = Number(cs.toFixed(3)); rec.proposed_cut_end = Number(ce.toFixed(3))
    if (rem < settings.minRemovedS) { rec.rejected_due_to_min_removed = true; dMinRemoved++; per.push(rec); return }
    if (overlapsWordCut(cs, ce)) { rec.rejected_due_to_word_cut_overlap = true; dOverlap++; per.push(rec); return }
    if (!edgeRemovable(cs, ce)) { rec.rejected_due_to_vad_speech_inside_center = true; dVad++; per.push(rec); return }
    rec.final_cut_start = Number(cs.toFixed(3)); rec.final_cut_end = Number(ce.toFixed(3))
    rec.removed_s = Number(rem.toFixed(3)); rec.remaining_pause_s = Number((rec.transcript_gap_duration - rem).toFixed(3)); rec.removal_ratio = Number((rem / rec.transcript_gap_duration).toFixed(3))
    rec.kept = true; per.push(rec); kept.push({ rec, cutStart: cs, cutEnd: ce })
  }
  if (words.length) {
    // leading: [0, firstWord true onset] → trim to a safe pre-roll (0.20–0.35s) so a
    // record-button click before the talking is removed without clipping the word.
    const first = words[0]
    const onsetV = vadOnset(first.start, vad)
    const leadEnd = onsetV != null ? onsetV : vadSpeechStart(first, vad)
    if (leadEnd > 0.02) {
      const blob = nonSilenceBlobs(0, leadEnd, vad).slice(-1)[0] // click/noise closest to the first word
      if (blob && blob.end - blob.start > 0.05) logIsland(blob.start, blob.end, 'leading_edge', '(video start)', 0, first.word, first.start, classifyNoTranscriptIsland(blob.end - blob.start))
      const preroll = Math.max(RIGHT_LEAD_S, EDGE_PREROLL_S)
      tryEdge(mkEdge('(video start)', first.word, 0, leadEnd, 0, preroll), 0, Math.max(0, leadEnd - preroll))
    }
    // trailing: [lastWord real speech end, media end] → keep a left-guard tail;
    // strip trailing handling noise, protect a real outro.
    const last = words[words.length - 1]
    const trailStart = vadSpeechEnd(last, vad)
    const lgE = FRAGILE.has(normWord(last.word)) ? Math.max(settings.paddingBeforeS, FRAGILE_LEFT_FLOOR) : settings.paddingBeforeS
    if (totalDurationS > trailStart + 0.02) {
      const blob = nonSilenceBlobs(trailStart, totalDurationS, vad)[0] // click/noise closest to the last word
      if (blob && blob.end - blob.start > 0.05) logIsland(blob.start, blob.end, 'trailing_edge', last.word, last.end, '(video end)', totalDurationS, classifyNoTranscriptIsland(blob.end - blob.start))
      tryEdge(mkEdge(last.word, '(video end)', trailStart, totalDurationS, lgE, 0), trailStart + lgE, totalDurationS)
    }
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
      carved_around_speech_islands: carvedCount,
      rejected_due_to_vad_speech_inside_center: dVad,
      rejected_due_to_word_cut_overlap: dOverlap,
      rejected_due_to_sliver: dSliver,
      rejected_due_to_cut_density: dDensity,
      rejected_due_to_timeline_micro_clip: 0,
      merged_with_word_cut: merged,
      noise_islands_removed: noiseRemoved,
      speech_islands_protected: speechProtected,
      no_transcript_islands: noTranscriptIslands,
      final_silence_regions_staged: regions.length,
      total_silence_removed_s: Number(total.toFixed(3)),
      per_region: per
    }
  }
}
