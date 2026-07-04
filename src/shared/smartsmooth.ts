/**
 * Smart Smooth Cut (beta) — decision system. PURE module (no IO, no ffmpeg, no
 * API): fully headless-testable, isolated from the existing engines.
 *
 * Pipeline (renderer orchestrates via store.smartSmoothCut):
 *   words (whisper timestamps, PRIMARY timing) + VAD silences (CANDIDATE
 *   detector only) + waveform peaks (audio features)
 *     -> buildPauseCandidates()      every possible pause, as pause_analysis
 *     -> applyRules()                deterministic decisions for obvious cases
 *     -> [AI judge, ambiguous only]  via main/ai-cut-judge (optional; JSON only)
 *     -> validateAiDecisions()       clamp/reject bad AI output
 *     -> finalizeDecisions()         density/micro-clip guards + padding ->
 *                                    SilenceRegion additions + retake word ids
 *
 * The OUTPUT plugs into the EXISTING edit model (project.silences + deleted
 * words -> computeKeepRanges), so preview/export/undo work unchanged and the
 * standard engines (VAD Detect silence, Fast Cut, Smart cut AI) are untouched.
 */
import type { SilenceRegion, Waveform, Word } from './types'

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type SmartCutPresetName = 'natural' | 'tiktok_smooth' | 'aggressive'
export type EditingStyle = SmartCutPresetName

export interface SmartCutPreset {
  min_pause_to_consider_ms: number
  keep_after_shortening_ms: number
  max_cuts_per_10s: number
  speech_pad_start_ms: number
  speech_pad_end_ms: number
  audio_fade_ms: number
}

export const SMART_CUT_PRESETS: Record<SmartCutPresetName, SmartCutPreset> = {
  natural: {
    min_pause_to_consider_ms: 900,
    keep_after_shortening_ms: 300,
    max_cuts_per_10s: 3,
    speech_pad_start_ms: 160,
    speech_pad_end_ms: 240,
    audio_fade_ms: 35
  },
  tiktok_smooth: {
    min_pause_to_consider_ms: 650,
    keep_after_shortening_ms: 180,
    max_cuts_per_10s: 5,
    speech_pad_start_ms: 120,
    speech_pad_end_ms: 200,
    audio_fade_ms: 25
  },
  aggressive: {
    min_pause_to_consider_ms: 450,
    keep_after_shortening_ms: 100,
    max_cuts_per_10s: 8,
    speech_pad_start_ms: 80,
    speech_pad_end_ms: 140,
    audio_fade_ms: 20
  }
}

export const DEFAULT_SMART_CUT_PRESET: SmartCutPresetName = 'tiktok_smooth'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnergyLevel = 'low' | 'medium' | 'high' | null
export type Likelihood = 'low' | 'medium' | 'high'
export type CutVerdict = 'keep' | 'shorten' | 'remove'

export interface PauseAnalysis {
  pause_id: string
  start: number
  end: number
  duration_ms: number
  before_text: string
  after_text: string
  previous_words: string[]
  next_words: string[]
  speech_rate_before: number | null
  speech_rate_after: number | null
  energy_before: EnergyLevel
  energy_during: EnergyLevel
  energy_after: EnergyLevel
  energy_jump_after_pause: boolean
  zero_crossing_rate_during: number | null // TODO: needs raw PCM (waveform peaks can't provide it)
  spectral_centroid_during: number | null // TODO: needs FFT over raw PCM
  breath_like: boolean
  sentence_boundary: boolean
  repeated_phrase_likelihood: Likelihood
  candidate_type: string
  /** where this candidate came from: transcript word gap, VAD, or both. */
  source: 'word_gap' | 'vad' | 'both'
  /** internal: index of the word BEFORE the pause (-1 = none). */
  prevWordIdx: number
}

export interface CutDecision {
  pause_id: string
  source: 'rules' | 'ai' | 'guard'
  decision: CutVerdict
  keep_ms?: number
  reason: string
}

export interface SmartSmoothResult {
  /** new silence-style regions to merge into project.silences (actions set). */
  silenceAdds: SilenceRegion[]
  /** earlier-failed-take words to flag for review->Delete (like Fast Cut). */
  retakeWordIds: string[]
  decisions: CutDecision[]
  debug: SmartSmoothDebug
}

export interface SmartSmoothDebug {
  mode: 'smart_smooth'
  preset: SmartCutPresetName
  raw_vad_segments: { start: number; end: number }[]
  transcript_words: number
  pause_candidates: PauseAnalysis[]
  rule_decisions: CutDecision[]
  ai_decisions: CutDecision[]
  final_cut_timeline: { start: number; end: number; action: string; shortenTo?: number }[]
  rejected_candidates: { pause_id: string; reason: string }[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9']/g, '')
const ENDS_SENTENCE = /[.!?…]["')\]]*$/

function rate(words: Word[]): number | null {
  if (words.length < 2) return null
  const dur = words[words.length - 1].end - words[0].start
  return dur > 0.05 ? Number((words.length / dur).toFixed(2)) : null
}

/** Average waveform peak over [a,b] seconds; null when no waveform. */
function avgPeak(wf: Waveform | null, a: number, b: number): number | null {
  if (!wf || !wf.peaks.length || b <= a) return null
  const i0 = Math.max(0, Math.floor(a * wf.peaksPerSec))
  const i1 = Math.min(wf.peaks.length - 1, Math.ceil(b * wf.peaksPerSec))
  if (i1 < i0) return null
  let sum = 0
  for (let i = i0; i <= i1; i++) sum += wf.peaks[i]
  return sum / (i1 - i0 + 1)
}

/** Reference "speech loudness": median peak inside word spans (robust vs music/noise). */
function speechRef(wf: Waveform | null, words: Word[]): number {
  if (!wf || !wf.peaks.length) return 0.3
  const samples: number[] = []
  for (let i = 0; i < words.length; i += Math.max(1, Math.floor(words.length / 200))) {
    const p = avgPeak(wf, words[i].start, words[i].end)
    if (p != null && p > 0.01) samples.push(p)
  }
  if (!samples.length) return 0.3
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

function level(p: number | null, ref: number): EnergyLevel {
  if (p == null) return null
  const r = p / Math.max(1e-4, ref)
  if (r < 0.35) return 'low'
  if (r > 0.9) return 'high'
  return 'medium'
}

/** Repeated-take likelihood: do the words right AFTER the pause re-say an
 *  opening found right BEFORE it? (classic restart: "so I went— so I went to"). */
function repeatLikelihood(before: Word[], after: Word[]): { like: Likelihood; matchStart: number } {
  const a = after.slice(0, 4).map((w) => norm(w.text)).filter(Boolean)
  if (a.length < 2) return { like: 'low', matchStart: -1 }
  const b = before.map((w) => norm(w.text))
  for (let s = 0; s < b.length - 1; s++) {
    let n = 0
    while (n < a.length && s + n < b.length && b[s + n] === a[n]) n++
    if (n >= 3) return { like: 'high', matchStart: s }
    if (n === 2 && s >= b.length - 4) return { like: 'medium', matchStart: s }
  }
  return { like: 'low', matchStart: -1 }
}

// ---------------------------------------------------------------------------
// 1) Pause candidates
// ---------------------------------------------------------------------------

/** Collect every pause candidate: transcript word gaps (primary) + VAD regions
 *  (candidate detector only — clamped to word boundaries so we NEVER cut inside
 *  a word). Gaps below 300ms are ignored outright (never cuttable). */
export function buildPauseCandidates(
  words: Word[],
  vad: { start: number; end: number }[],
  waveform: Waveform | null
): PauseAnalysis[] {
  const alive = words.filter((w) => !w.deleted)
  const out: PauseAnalysis[] = []
  const ref = speechRef(waveform, alive)
  let n = 0

  const mk = (start: number, end: number, prevIdx: number, source: PauseAnalysis['source']): PauseAnalysis | null => {
    const durMs = (end - start) * 1000
    if (durMs < 300) return null
    const before = alive.slice(Math.max(0, prevIdx - 7), prevIdx + 1)
    const after = alive.slice(prevIdx + 1, prevIdx + 8)
    const eBefore = avgPeak(waveform, Math.max(0, start - 0.8), start)
    const eDuring = avgPeak(waveform, start, end)
    const eAfter = avgPeak(waveform, end, end + 0.8)
    const lBefore = level(eBefore, ref)
    const lDuring = level(eDuring, ref)
    const lAfter = level(eAfter, ref)
    const jump = eDuring != null && eAfter != null && eAfter > eDuring * 2.2 && lAfter === 'high'
    const sentence = before.length > 0 && ENDS_SENTENCE.test(before[before.length - 1].text.trim())
    const rep = repeatLikelihood(before, after)
    const breath =
      durMs >= 150 && durMs <= 900 && lDuring === 'low' && (eDuring ?? 0) > 0.008 && after.length > 0
    let type = 'pause'
    if (rep.like === 'high') type = 'retake_reset'
    else if (durMs > 1800) type = 'dead_air'
    else if (breath) type = 'breath'
    else if (sentence && jump) type = 'possible_dramatic_pause'
    else if (sentence) type = 'sentence_pause'
    return {
      pause_id: `pause_${String(++n).padStart(3, '0')}`,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration_ms: Math.round(durMs),
      before_text: before.slice(-3).map((w) => w.text).join(' '),
      after_text: after.slice(0, 3).map((w) => w.text).join(' '),
      previous_words: before.slice(-3).map((w) => w.text),
      next_words: after.slice(0, 3).map((w) => w.text),
      speech_rate_before: rate(before),
      speech_rate_after: rate(after),
      energy_before: lBefore,
      energy_during: lDuring,
      energy_after: lAfter,
      energy_jump_after_pause: jump,
      zero_crossing_rate_during: null, // TODO: raw-PCM feature
      spectral_centroid_during: null, // TODO: raw-PCM feature
      breath_like: breath,
      sentence_boundary: sentence,
      repeated_phrase_likelihood: rep.like,
      candidate_type: type,
      source,
      prevWordIdx: prevIdx
    }
  }

  // Primary: gaps between consecutive transcript words.
  const gapAt = new Map<number, PauseAnalysis>()
  for (let i = 0; i < alive.length - 1; i++) {
    const gapStart = alive[i].end
    const gapEnd = alive[i + 1].start
    const c = mk(gapStart, gapEnd, i, 'word_gap')
    if (c) {
      gapAt.set(i, c)
      out.push(c)
    }
  }

  // VAD regions: candidate detector only. Whisper.cpp word timestamps are
  // typically CONTIGUOUS (a word's span swallows the silence after it), so a
  // real pause often sits INSIDE a word's padded span rather than in a gap.
  // Clamp each VAD region so it never cuts the SPOKEN head of a word, then
  // anchor it as a pause after the owning word.
  for (const r of vad) {
    // word whose span the region STARTS in (or the last word before it)
    let prevIdx = -1
    for (let i = 0; i < alive.length; i++) {
      if (alive[i].start <= r.start + 0.02) prevIdx = i
      else break
    }
    const w = prevIdx >= 0 ? alive[prevIdx] : null
    // never bite into the owning word's spoken head — keep >=120ms of it,
    // and never cross into the NEXT word's span.
    const lo = w ? Math.max(r.start, Math.min(w.end, w.start + 0.12)) : r.start
    const hi = prevIdx + 1 < alive.length ? alive[prevIdx + 1].start : Number.POSITIVE_INFINITY
    const s = Math.max(r.start, lo)
    const e = Math.min(r.end, hi)
    if (e - s < 0.3) continue
    const existing = gapAt.get(prevIdx)
    if (existing) {
      existing.source = 'both'
      continue
    }
    const c = mk(s, e === Number.POSITIVE_INFINITY ? r.end : e, prevIdx, 'vad')
    if (c) out.push(c)
  }

  out.sort((a, b) => a.start - b.start)
  return out
}

// ---------------------------------------------------------------------------
// 2) Deterministic rules
// ---------------------------------------------------------------------------

export function applyRules(
  cands: PauseAnalysis[],
  preset: SmartCutPreset
): { decisions: CutDecision[]; ambiguous: PauseAnalysis[] } {
  const decisions: CutDecision[] = []
  const ambiguous: PauseAnalysis[] = []
  for (const c of cands) {
    const d = c.duration_ms
    const push = (decision: CutVerdict, reason: string, keep_ms?: number): void => {
      decisions.push({ pause_id: c.pause_id, source: 'rules', decision, reason, keep_ms })
    }
    if (d < Math.max(350, preset.min_pause_to_consider_ms * 0.5)) {
      push('keep', 'Pause is under the minimum cut threshold.')
    } else if (c.repeated_phrase_likelihood === 'high') {
      // Rule 6: restart reset — collapse the reset pause hard.
      push('shorten', 'Repeated-phrase restart: shortening the reset pause.', preset.keep_after_shortening_ms)
    } else if (d < preset.min_pause_to_consider_ms) {
      push('keep', `Under the preset's ${preset.min_pause_to_consider_ms}ms consideration floor.`)
    } else if (d <= 700) {
      push('keep', 'Short pause (350–700ms): natural rhythm, keep.')
    } else if (c.breath_like && c.energy_jump_after_pause) {
      // Rule 5: breath before a strong line — keep a beat, don't erase it.
      push('shorten', 'Breath before an energetic line: keep a short beat.', Math.min(250, Math.max(150, preset.keep_after_shortening_ms)))
    } else if (d > 1800) {
      if (c.candidate_type === 'possible_dramatic_pause') {
        ambiguous.push(c) // long but maybe intentional — let the judge decide
      } else {
        push('shorten', 'Long dead air (>1800ms): shorten to a natural beat.', preset.keep_after_shortening_ms)
      }
    } else {
      // 700–1800ms: ambiguous unless obviously dead air.
      if (c.candidate_type === 'dead_air' || (c.energy_during === 'low' && !c.sentence_boundary && !c.breath_like)) {
        push('shorten', 'Mid-length awkward dead air.', preset.keep_after_shortening_ms)
      } else {
        ambiguous.push(c)
      }
    }
  }
  return { decisions, ambiguous }
}

/** Conservative fallback for ambiguous pauses when the AI judge is unavailable
 *  or fails — the job must never crash (rules-only smart cut). */
export function fallbackDecisions(ambiguous: PauseAnalysis[], preset: SmartCutPreset): CutDecision[] {
  return ambiguous.map((c) => {
    const keepish =
      c.candidate_type === 'possible_dramatic_pause' || c.breath_like || (c.sentence_boundary && c.duration_ms < 1200)
    return {
      pause_id: c.pause_id,
      source: 'guard' as const,
      decision: keepish ? ('keep' as const) : ('shorten' as const),
      keep_ms: keepish ? undefined : preset.keep_after_shortening_ms,
      reason: keepish
        ? 'No AI judge: conservative keep (looks intentional/emotional).'
        : 'No AI judge: mid-length flat pause shortened by fallback rule.'
    }
  })
}

// ---------------------------------------------------------------------------
// 3) AI judge I/O validation
// ---------------------------------------------------------------------------

/** Parse + sanity-check the AI judge's JSON. Anything invalid is dropped; the
 *  caller backfills with fallbackDecisions(). Never throws. */
export function validateAiDecisions(raw: string, cands: PauseAnalysis[]): CutDecision[] {
  try {
    const cleaned = raw.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim()
    const parsed = JSON.parse(cleaned)
    const list = Array.isArray(parsed?.decisions) ? parsed.decisions : []
    const byId = new Map(cands.map((c) => [c.pause_id, c]))
    const out: CutDecision[] = []
    for (const d of list) {
      const c = byId.get(String(d?.pause_id))
      if (!c) continue
      const decision = String(d?.decision) as CutVerdict
      if (decision !== 'keep' && decision !== 'shorten' && decision !== 'remove') continue
      let keep_ms: number | undefined
      if (decision === 'shorten') {
        const k = Number(d?.keep_ms)
        keep_ms = Number.isFinite(k) ? Math.round(Math.min(c.duration_ms - 40, Math.max(80, k))) : 180
      }
      out.push({ pause_id: c.pause_id, source: 'ai', decision, keep_ms, reason: String(d?.reason || 'AI judge decision') })
    }
    return out
  } catch {
    return [] // invalid JSON -> caller falls back to rules
  }
}

// ---------------------------------------------------------------------------
// 4) Finalize: guards + padding -> silence regions & retake ids
// ---------------------------------------------------------------------------

export function finalizeDecisions(
  cands: PauseAnalysis[],
  decisions: CutDecision[],
  preset: SmartCutPreset,
  words: Word[],
  existingSilences: SilenceRegion[]
): { silenceAdds: SilenceRegion[]; retakeWordIds: string[]; rejected: { pause_id: string; reason: string }[]; warnings: string[] } {
  const byId = new Map(cands.map((c) => [c.pause_id, c]))
  const rejected: { pause_id: string; reason: string }[] = []
  const warnings: string[] = []
  const alive = words.filter((w) => !w.deleted)

  // Cut-density guard (rule 8): at most max_cuts_per_10s in any 10s window —
  // keep the LONGEST pauses (they matter most), downgrade the rest.
  const cuts = decisions
    .filter((d) => d.decision !== 'keep' && byId.has(d.pause_id))
    .sort((a, b) => byId.get(a.pause_id)!.start - byId.get(b.pause_id)!.start)
  const kept: CutDecision[] = []
  for (const d of cuts) {
    const c = byId.get(d.pause_id)!
    const windowCuts = kept.filter((k) => Math.abs(byId.get(k.pause_id)!.start - c.start) < 10)
    if (windowCuts.length >= preset.max_cuts_per_10s) {
      const shortest = windowCuts.reduce((m, k) => (byId.get(k.pause_id)!.duration_ms < byId.get(m.pause_id)!.duration_ms ? k : m), windowCuts[0])
      if (byId.get(shortest.pause_id)!.duration_ms < c.duration_ms) {
        kept.splice(kept.indexOf(shortest), 1)
        rejected.push({ pause_id: shortest.pause_id, reason: 'Cut-density guard: too many cuts in 10s; kept the longer pause instead.' })
        kept.push(d)
      } else {
        rejected.push({ pause_id: d.pause_id, reason: 'Cut-density guard: too many cuts in 10s.' })
      }
    } else {
      kept.push(d)
    }
  }

  // Micro-clip guard (rule 9): a cut must not leave a kept speech island < 600ms
  // between itself and the previous cut.
  const MIN_KEPT = 0.6
  const accepted: CutDecision[] = []
  let lastCutEnd = -1
  for (const d of kept.sort((a, b) => byId.get(a.pause_id)!.start - byId.get(b.pause_id)!.start)) {
    const c = byId.get(d.pause_id)!
    if (lastCutEnd >= 0 && c.start - lastCutEnd < MIN_KEPT) {
      rejected.push({ pause_id: d.pause_id, reason: 'Micro-clip guard: would leave a kept segment under 600ms.' })
      continue
    }
    accepted.push(d)
    lastCutEnd = c.end
  }

  // Convert to silence regions with speech padding. Padding: leave
  // speech_pad_end_ms after the preceding word and speech_pad_start_ms before
  // the next word, so cuts never clip speech onsets/tails (word-safe by
  // construction: regions only ever live inside word gaps).
  const padS = preset.speech_pad_start_ms / 1000
  const padE = preset.speech_pad_end_ms / 1000
  const silenceAdds: SilenceRegion[] = []
  let idx = 0
  for (const d of accepted) {
    const c = byId.get(d.pause_id)!
    if (existingSilences.some((r) => r.action !== 'keep' && c.start < r.end && r.start < c.end)) {
      rejected.push({ pause_id: d.pause_id, reason: 'Overlaps an existing user silence region — left untouched.' })
      continue
    }
    if (d.decision === 'remove') {
      const s = c.start + padE
      const e = c.end - padS
      if (e - s < 0.08) {
        rejected.push({ pause_id: d.pause_id, reason: 'Too short to remove once speech padding applied.' })
        continue
      }
      silenceAdds.push({ id: `ss-${++idx}-${d.pause_id}`, start: s, end: e, action: 'remove' })
    } else {
      const keepSec = Math.max((d.keep_ms ?? preset.keep_after_shortening_ms) / 1000, padS + padE ? 0.08 : 0.08)
      if (c.end - c.start <= keepSec + 0.05) {
        rejected.push({ pause_id: d.pause_id, reason: 'Shorten target ≈ pause length — nothing to trim.' })
        continue
      }
      silenceAdds.push({ id: `ss-${++idx}-${d.pause_id}`, start: c.start, end: c.end, action: 'shorten', shortenTo: keepSec })
    }
  }

  // Retake word flagging: for high-likelihood restarts, flag the EARLIER
  // abandoned attempt (from the matched opening to the pause) for review.
  const retakeWordIds: string[] = []
  for (const c of cands) {
    if (c.repeated_phrase_likelihood !== 'high') continue
    const before = alive.slice(Math.max(0, c.prevWordIdx - 7), c.prevWordIdx + 1)
    const after = alive.slice(c.prevWordIdx + 1, c.prevWordIdx + 8)
    const rep = repeatLikelihood(before, after)
    if (rep.matchStart < 0) continue
    for (let i = rep.matchStart; i < before.length; i++) retakeWordIds.push(before[i].id)
  }
  if (retakeWordIds.length) warnings.push(`${retakeWordIds.length} retake word(s) flagged for review — press Delete in the transcript to apply.`)

  return { silenceAdds, retakeWordIds, rejected, warnings }
}

// ---------------------------------------------------------------------------
// Orchestrator (pure aside from the injected async AI judge)
// ---------------------------------------------------------------------------

export interface AiJudgeInput {
  editingStyle: EditingStyle
  videoDuration: number
  pauseCandidates: Omit<PauseAnalysis, 'prevWordIdx'>[]
}

export async function runSmartSmoothCut(opts: {
  words: Word[]
  vad: { start: number; end: number }[]
  waveform: Waveform | null
  preset: SmartCutPresetName
  existingSilences: SilenceRegion[]
  videoDuration: number
  /** async judge: gets structured JSON, returns the raw model text (JSON). */
  aiJudge?: (input: AiJudgeInput) => Promise<string>
}): Promise<SmartSmoothResult> {
  const presetName = SMART_CUT_PRESETS[opts.preset] ? opts.preset : DEFAULT_SMART_CUT_PRESET
  const preset = SMART_CUT_PRESETS[presetName]
  const warnings: string[] = []
  if (!opts.waveform) warnings.push('No waveform available — audio features skipped (nulls); rules used text/timing only.')
  if (!opts.vad.length) warnings.push('No VAD regions available — candidates from transcript word gaps only.')

  const cands = buildPauseCandidates(opts.words, opts.vad, opts.waveform)
  const { decisions: ruleDecisions, ambiguous } = applyRules(cands, preset)

  let aiDecisions: CutDecision[] = []
  if (ambiguous.length && opts.aiJudge) {
    try {
      const raw = await opts.aiJudge({
        editingStyle: presetName,
        videoDuration: opts.videoDuration,
        pauseCandidates: ambiguous.map(({ prevWordIdx: _p, ...rest }) => rest)
      })
      aiDecisions = validateAiDecisions(raw, ambiguous)
      if (!aiDecisions.length && raw.trim()) warnings.push('AI judge returned no valid decisions — fell back to rules.')
    } catch (e) {
      warnings.push(`AI judge failed (${(e as Error).message}) — rules-only smart cut.`)
    }
  }
  const judged = new Set(aiDecisions.map((d) => d.pause_id))
  const backfill = fallbackDecisions(ambiguous.filter((c) => !judged.has(c.pause_id)), preset)
  const all = [...ruleDecisions, ...aiDecisions, ...backfill]

  const fin = finalizeDecisions(cands, all, preset, opts.words, opts.existingSilences)
  warnings.push(...fin.warnings)

  const debug: SmartSmoothDebug = {
    mode: 'smart_smooth',
    preset: presetName,
    raw_vad_segments: opts.vad.map((r) => ({ start: r.start, end: r.end })),
    transcript_words: opts.words.length,
    pause_candidates: cands,
    rule_decisions: ruleDecisions,
    ai_decisions: aiDecisions,
    final_cut_timeline: fin.silenceAdds.map((r) => ({ start: r.start, end: r.end, action: r.action, shortenTo: r.shortenTo })),
    rejected_candidates: fin.rejected,
    warnings
  }
  return { silenceAdds: fin.silenceAdds, retakeWordIds: fin.retakeWordIds, decisions: all, debug }
}
