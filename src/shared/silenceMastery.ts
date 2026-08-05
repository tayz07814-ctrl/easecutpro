// Silence Mastery — the ONLY silence engine on this branch, built clean after
// every previous engine (Smart Silence, FSMN, Silero VAD, ffmpeg silencedetect)
// was ripped out.
//
// The rule is exactly one sentence: KEEP the word timestamps, CUT everything
// else. A 15s video whose words span 3–7s and 9–12s loses 0–3, 7–9 and 12–15.
// No audio analysis, no models — the transcript's word times are the truth.
//
// Three settings shape the cuts:
//   • minSilenceS  — a gap shorter than this is a natural beat; leave it.
//   • padLeftMs    — silence KEPT on the left edge of a removed gap (right
//                    after the word that precedes it), so tails can breathe.
//   • padRightMs   — silence KEPT on the right edge (just before the next
//                    word begins), protecting soft onsets.
//   • trimEdgesMs  — the opposite of padding: moves the cutter INTO the word
//                    timestamps by this many ms on both sides of the gap,
//                    eating the tail of the word before and the onset of the
//                    word after (ASR word ends often carry dead air).
//
// PURE module — no IO — headless-testable (scripts/verify-silence-mastery.ts).

import type { SilenceRegion } from './types'

export interface SilenceMasterySettings {
  /** gaps shorter than this many seconds are kept (natural beats). */
  minSilenceS: number
  /** silence kept AFTER the word preceding a removed gap (ms). */
  padLeftMs: number
  /** silence kept BEFORE the word following a removed gap (ms). */
  padRightMs: number
  /** cut extended LEFT into the ENDING speech (the tail of the sentence
   *  before the gap) beyond the detected edge (ms). */
  trimLeftMs: number
  /** cut extended RIGHT into the STARTING speech (the onset of the next
   *  sentence) beyond the detected edge (ms). */
  trimRightMs: number
  /** Repair STRETCHED word timestamps before planning: ASR often extends a
   *  word's end straight through the pause that follows it (a real 2.5s
   *  "Okay." span whose spoken part is 0.5s), hiding dead air INSIDE the word
   *  where no gap rule can see it. When on, a word implausibly long for its
   *  letter count is clamped and the exposed tail becomes a normal cuttable
   *  gap. Verified against real data (the Sova script's 33.28–35.79 "Okay."). */
  clampStretchedWords: boolean
  /** RMS energy pass (auto threshold): frame the actual audio, derive the
   *  silence threshold from its own noise floor / speech level, and cut every
   *  low-energy run the transcript pass missed — never within 100ms of a
   *  spoken word's timestamps. Catches dead air ASR hid entirely. */
  rmsPass: boolean
  /** Silero VAD pass — STAGE 1 of the hybrid: the neural VAD listens to the
   *  audio and its non-speech regions are cut first (100ms preserved around
   *  every speech segment it heard, edges clamped off transcript word spans);
   *  the transcript-gap pass then sweeps only what Silero left. */
  sileroPass: boolean
  /** Word-timestamp (transcript-gap) pass — cuts the gaps between word
   *  stamps using minSilence/pads/trim. Off = Silero-only cleaning. */
  gapPass: boolean
  /** "Mad Scientist" lever (UI-only — the engine ignores it): ON unlocks the
   *  sliders for hand-tuned values; OFF keeps the modal preset-chips-only. */
  madScientist: boolean
  /** Breath cleanup (RMS edge refinement) at SENTENCE ENDINGS: walk each
   *  detected region's LEFT edge back over low-energy breath frames so the
   *  cut lands where the voice stops. Endings only — the right edge (the next
   *  sentence's onset) is never walked, soft onsets were getting overcut.
   *  On for the aggressive presets (Flash, Cut Throat); off for the gentle
   *  two (Natural Rhythm, No Chill). */
  breathRefine: boolean
}

export const DEFAULT_SILENCE_MASTERY_SETTINGS: SilenceMasterySettings = {
  // Default = the "Flash" preset: no pads, trims cutting 50ms into the
  // sentence ending and 150ms into the next sentence's onset.
  minSilenceS: 0.15,
  padLeftMs: 0,
  padRightMs: 0,
  trimLeftMs: 50,
  trimRightMs: 150,
  clampStretchedWords: true,
  // SILERO-ONLY (final engine config — locked in normalizeSilenceMastery).
  rmsPass: false,
  sileroPass: true,
  gapPass: false,
  madScientist: false,
  breathRefine: true
}

/** The creator presets (numeric fields only). "Mad Scientist" is the modal's
 *  fifth chip — not listed here because it has no fixed values: its lever
 *  unlocks the sliders for hand-tuned settings. */
export interface SilenceMasteryPreset {
  id: string
  label: string
  values: Pick<SilenceMasterySettings, 'minSilenceS' | 'padLeftMs' | 'padRightMs' | 'trimLeftMs' | 'trimRightMs' | 'breathRefine'>
}
export const SILENCE_MASTERY_PRESETS: SilenceMasteryPreset[] = [
  {
    // Gentle: keeps a breath at both detected edges, no trimming into speech,
    // no breath cleanup.
    id: 'natural-rhythm',
    label: 'Natural Rhythm',
    values: { minSilenceS: 0.25, padLeftMs: 50, padRightMs: 100, trimLeftMs: 0, trimRightMs: 0, breathRefine: false }
  },
  {
    id: 'no-chill',
    label: 'No Chill',
    values: { minSilenceS: 0.15, padLeftMs: 0, padRightMs: 0, trimLeftMs: 20, trimRightMs: 50, breathRefine: false }
  },
  {
    // THE DEFAULT (mirrors DEFAULT_SILENCE_MASTERY_SETTINGS above). Breath
    // cleanup on: sentence-ending exhales are walked over adaptively.
    id: 'flash',
    label: 'Flash',
    values: { minSilenceS: 0.15, padLeftMs: 0, padRightMs: 0, trimLeftMs: 50, trimRightMs: 150, breathRefine: true }
  },
  {
    // Cuts hard PAST the detected silence: 100ms off the sentence ending
    // (left of the gap) and 350ms off the next sentence's onset (right).
    id: 'cut-throat',
    label: 'Cut Throat',
    values: { minSilenceS: 0.15, padLeftMs: 0, padRightMs: 0, trimLeftMs: 100, trimRightMs: 350, breathRefine: true }
  }
]
/** The preset the current numeric values exactly match, else null (custom). */
export function matchSilenceMasteryPreset(s: SilenceMasterySettings): string | null {
  for (const p of SILENCE_MASTERY_PRESETS) {
    const v = p.values
    if (
      Math.abs(v.minSilenceS - s.minSilenceS) < 1e-9 &&
      v.padLeftMs === s.padLeftMs &&
      v.padRightMs === s.padRightMs &&
      v.trimLeftMs === s.trimLeftMs &&
      v.trimRightMs === s.trimRightMs &&
      v.breathRefine === s.breathRefine
    )
      return p.id
  }
  return null
}

const clampN = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt
  return Math.max(lo, Math.min(hi, n))
}

/** Clamp a possibly-partial persisted value back onto sane ranges. */
export function normalizeSilenceMastery(
  v: Partial<SilenceMasterySettings> | null | undefined
): SilenceMasterySettings {
  const d = DEFAULT_SILENCE_MASTERY_SETTINGS
  return {
    minSilenceS: clampN(v?.minSilenceS, 0.05, 5, d.minSilenceS),
    padLeftMs: clampN(v?.padLeftMs, 0, 1000, d.padLeftMs),
    padRightMs: clampN(v?.padRightMs, 0, 1000, d.padRightMs),
    // legacy symmetric trimEdgesMs (pre-preset) feeds both sides
    trimLeftMs: clampN(v?.trimLeftMs ?? (v as { trimEdgesMs?: number } | null | undefined)?.trimEdgesMs, 0, 500, d.trimLeftMs),
    trimRightMs: clampN(v?.trimRightMs ?? (v as { trimEdgesMs?: number } | null | undefined)?.trimEdgesMs, 0, 500, d.trimRightMs),
    // FINAL ENGINE LOCK — Silero VAD is this branch's one and only silence
    // engine. The pass toggles are gone from the UI, so stale persisted
    // values must not be able to turn Silero off or resurrect the
    // transcript-gap / RMS passes.
    clampStretchedWords: d.clampStretchedWords,
    rmsPass: false,
    sileroPass: true,
    gapPass: false,
    // The Mad Scientist lever and breath cleanup are real user choices
    // (unlike the locked pass flags above) — persist them.
    madScientist: typeof v?.madScientist === 'boolean' ? v.madScientist : d.madScientist,
    breathRefine: typeof v?.breathRefine === 'boolean' ? v.breathRefine : d.breathRefine
  }
}

export interface SpeechSpan {
  /** seconds, source time. */
  start: number
  end: number
  /** the word's text — used only by the stretched-word clamp (optional). */
  text?: string
}

/** One repaired word, for the debug record. */
export interface StretchedWordRepair {
  text: string
  start: number
  origEnd: number
  clampedEnd: number
  exposedS: number
}

// Stretched-word clamp tuning: a word's plausible max duration grows with its
// letter count; anything past that (by a real margin) is ASR-absorbed dead air.
const STRETCH_PER_CHAR_S = 0.09
const STRETCH_BASE_S = 0.25
const STRETCH_MIN_MAX_S = 0.65
const STRETCH_MIN_EXPOSED_S = 0.35

const plausibleMaxDurS = (text: string): number => {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length
  return Math.max(STRETCH_MIN_MAX_S, STRETCH_BASE_S + STRETCH_PER_CHAR_S * letters)
}

/** Clamp implausibly long word spans (dead air absorbed into the word's end).
 *  Pure; returns the repaired spans + what was repaired. A word whose span
 *  contains another word's start is left alone (overlapping ASR, not a stretch). */
export function clampStretchedWords(words: SpeechSpan[]): { words: SpeechSpan[]; repairs: StretchedWordRepair[] } {
  const repairs: StretchedWordRepair[] = []
  const out = words.map((w, i) => {
    const text = w.text ?? ''
    if (!text) return w
    const dur = w.end - w.start
    const maxDur = plausibleMaxDurS(text)
    if (dur - maxDur < STRETCH_MIN_EXPOSED_S) return w
    const wordInside = words.some((o, j) => j !== i && o.start > w.start + 0.01 && o.start < w.end - 0.01)
    if (wordInside) return w
    const clampedEnd = w.start + maxDur
    repairs.push({
      text,
      start: Math.round(w.start * 100) / 100,
      origEnd: Math.round(w.end * 100) / 100,
      clampedEnd: Math.round(clampedEnd * 100) / 100,
      exposedS: Math.round((w.end - clampedEnd) * 100) / 100
    })
    return { ...w, end: clampedEnd }
  })
  return { words: out, repairs }
}

/** A word never loses more than half of itself to trim — the cutter may bite
 *  into a word's edge (that's what trimEdgesMs is for) but can never swallow
 *  or cross it, no matter how large the setting relative to a short word. */
const wordFloor = (w: SpeechSpan): number => (w.start + w.end) / 2

/**
 * Plan the cuts: every region not covered by a word — leading silence before
 * the first word, inter-word gaps, trailing silence after the last word — is
 * removed when its RAW length ≥ minSilenceS. Pads shrink each cut inward from
 * the gap's edges; trim grows it outward into the neighbouring words.
 *
 * `words` = the KEPT transcript words (seconds); `durationS` = media length.
 * Returns protect:true regions — computeKeepRanges applies them verbatim.
 */
export function planSilenceMastery(
  words: SpeechSpan[],
  durationS: number,
  settings: SilenceMasterySettings
): SilenceRegion[] {
  return planSilenceMasteryDetailed(words, durationS, settings).regions
}

/** Same as planSilenceMastery, additionally reporting the stretched-word
 *  repairs it performed (for the debug record). */
export function planSilenceMasteryDetailed(
  words: SpeechSpan[],
  durationS: number,
  settings: SilenceMasterySettings
): { regions: SilenceRegion[]; stretched: StretchedWordRepair[] } {
  const s = normalizeSilenceMastery(settings)
  const padL = s.padLeftMs / 1000
  const padR = s.padRightMs / 1000
  const trimL = s.trimLeftMs / 1000
  const trimR = s.trimRightMs / 1000
  const MIN_CUT_S = 0.03 // a cut narrower than a frame is noise — drop it

  let input = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start)
  // Repair ASR-stretched word ends FIRST, so the dead air they hide becomes a
  // normal gap the rules below can cut. All pad/trim/midpoint math then runs on
  // the repaired spans (the cutter's midpoint guard uses the CLAMPED word).
  let stretched: StretchedWordRepair[] = []
  if (s.clampStretchedWords) {
    const r = clampStretchedWords(input)
    input = r.words
    stretched = r.repairs
  }
  const ws = input

  const cuts: { start: number; end: number }[] = []
  // A cut's edges: pad pulls inward from the gap boundary, trim pushes outward
  // into the word — they oppose each other, so the effective offset is
  // (pad − trim), clamped so the cutter never passes a word's midpoint.
  const leftEdge = (prev: SpeechSpan | null, gapStart: number): number =>
    prev ? Math.max(wordFloor(prev), gapStart + padL - trimL) : Math.max(0, gapStart)
  const rightEdge = (next: SpeechSpan | null, gapEnd: number): number =>
    next ? Math.min(wordFloor(next), gapEnd - padR + trimR) : gapEnd

  if (ws.length === 0) {
    // No words at all: the whole runtime is silence. Cut it in one piece when
    // it clears the threshold (an all-silent clip collapses to nothing).
    if (durationS >= s.minSilenceS) cuts.push({ start: 0, end: durationS })
  } else {
    // Leading silence: 0 → first word. No pad on the left (nothing speaks
    // before it); padRight/trim shape the right edge like any other cut.
    const first = ws[0]
    if (first.start >= s.minSilenceS) {
      const end = rightEdge(first, first.start)
      if (end - 0 >= MIN_CUT_S) cuts.push({ start: 0, end })
    }
    // Inter-word gaps. Words can overlap, touch, or sit fully INSIDE a longer
    // word's span (ASR quirks) — a gap only exists past the FURTHEST word end
    // seen so far, never just past the previous word's own end (a short word
    // contained in a long one must not open a phantom gap over speech).
    let cover = ws[0] // the word whose end is the furthest so far
    for (let i = 1; i < ws.length; i++) {
      const next = ws[i]
      const gapStart = cover.end
      const gapEnd = next.start
      if (gapEnd - gapStart >= s.minSilenceS) {
        const a = leftEdge(cover, gapStart)
        const b = rightEdge(next, gapEnd)
        if (b - a >= MIN_CUT_S) cuts.push({ start: a, end: b })
      }
      if (next.end > cover.end) cover = next
    }
    // Trailing silence: furthest word end → end of media. No pad on the right.
    if (durationS - cover.end >= s.minSilenceS) {
      const a = leftEdge(cover, cover.end)
      if (durationS - a >= MIN_CUT_S) cuts.push({ start: a, end: Math.max(a, durationS) })
    }
  }

  // Clamp into the media, merge any overlap, and stamp region ids.
  const merged: SilenceRegion[] = []
  for (const c of cuts) {
    const start = Math.max(0, c.start)
    const end = Math.min(Math.max(durationS, 0) || c.end, c.end)
    if (end - start < MIN_CUT_S) continue
    const lastR = merged[merged.length - 1]
    if (lastR && start <= lastR.end) lastR.end = Math.max(lastR.end, end)
    else merged.push({ id: '', start, end, action: 'remove', protect: true })
  }
  return { regions: merged.map((r, i) => ({ ...r, id: `sm${i}` })), stretched }
}

// ---------------------------------------------------------------------------
// RMS energy pass — the audio's own word: an ADAPTIVE threshold derived from
// the clip itself (noise floor vs speech level), applied to 20ms RMS frames.
// Catches dead air the transcript hides completely (mis-stamped words, breaths
// between stamps, room tone the ASR papered over). The transcript still rules
// where it speaks: nothing is cut within RMS_WORD_GUARD_S of a word span.
// ---------------------------------------------------------------------------

export const RMS_FRAME_MS = 20
/** spoken word timestamps are preserved with this margin on both sides. */
export const RMS_WORD_GUARD_S = 0.1
/** threshold sits this far above the measured noise floor… */
const RMS_SENSITIVITY_DB = 12
/** …but never closer than this below the measured speech level. */
const RMS_SPEECH_HEADROOM_DB = 8
/** if speech and floor are this close, the clip has no usable dynamic range
 *  (music bed, constant noise) — cut nothing rather than everything. */
const RMS_MIN_RANGE_DB = 6

/** Per-frame RMS level in dBFS (non-overlapping frames of `frameMs`). */
export function frameRmsDb(samples: ArrayLike<number>, sampleRate: number, frameMs = RMS_FRAME_MS): number[] {
  const n = Math.max(1, Math.floor((frameMs / 1000) * sampleRate))
  const frames = Math.floor(samples.length / n)
  const out: number[] = new Array(frames)
  for (let f = 0; f < frames; f++) {
    let acc = 0
    const base = f * n
    for (let i = 0; i < n; i++) {
      const s = samples[base + i] as number
      acc += s * s
    }
    out[f] = 20 * Math.log10(Math.sqrt(acc / n) + 1e-9)
  }
  return out
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))))] : -100

export interface RmsAutoThreshold {
  floorDb: number
  speechDb: number
  thresholdDb: number
  /** false when the clip has no usable dynamic range — the pass cuts nothing. */
  usable: boolean
}

/** Auto threshold: noise floor = p10 of frame RMS, speech = p90; threshold =
 *  floor + sensitivity, capped RMS_SPEECH_HEADROOM_DB under speech. */
export function rmsAutoThreshold(framesDb: number[]): RmsAutoThreshold {
  const sorted = [...framesDb].sort((a, b) => a - b)
  const floorDb = percentile(sorted, 0.1)
  const speechDb = percentile(sorted, 0.9)
  const usable = speechDb - floorDb >= RMS_MIN_RANGE_DB
  const thresholdDb = Math.min(floorDb + RMS_SENSITIVITY_DB, speechDb - RMS_SPEECH_HEADROOM_DB)
  return { floorDb, speechDb, thresholdDb, usable }
}

/** Max seconds an edge may be extended over breath-energy audio. Big enough
 *  for a long end-of-take exhale, small enough that a genuinely quiet spoken
 *  passage can't be swallowed whole. */
export const EDGE_REFINE_MAX_S = 1.5
/** Frames louder than speechDb minus this are VOICE — refinement stops there.
 *  Breaths sit ~15–25dB under voiced speech; soft word onsets sit well inside
 *  this margin and survive. */
const EDGE_REFINE_VOICE_MARGIN_DB = 15

/**
 * Breath-tail edge refinement — the adaptive answer to "even a 500ms trim
 * leaves breath trails". The VAD counts an audible breath as speech, so the
 * detected silence starts only AFTER the breath; any fixed trim then measures
 * from the wrong edge. Instead of a fixed bite, walk the region's LEFT edge
 * (the ENDING of the speech before the gap) backward over the audio's own
 * 20ms RMS frames: keep extending while the energy stays below the clip's
 * voice level (breaths do, voiced speech doesn't), capped at EDGE_REFINE_MAX_S.
 * The cut then lands where the VOICE stops, not where the noise stops.
 *
 * ENDINGS ONLY: the right edge (the next sentence's ONSET) is deliberately
 * never walked — soft onsets ("h", "s", whispered pickups) sit low enough in
 * energy that walking forward overcut real speech in testing.
 *
 * Runs BEFORE pads/trims, which shape the refined edge.
 */
export function refineRegionEdgesByRms(
  regions: { start: number; end: number }[],
  framesDb: number[],
  frameS: number,
  durationS: number
): { regions: { start: number; end: number }[]; info: RmsAutoThreshold | null } {
  if (!regions.length || !framesDb.length || frameS <= 0) return { regions, info: null }
  const t = rmsAutoThreshold(framesDb)
  if (!t.usable) return { regions, info: t }
  // A frame quieter than BOTH bounds is breath/noise, not voice: the auto
  // threshold anchors near the noise floor, the margin bound under the speech
  // level — the higher of the two decides, so a hot noise floor can't push
  // the cutoff into voiced territory and quiet voices keep their onsets.
  const cutoffDb = Math.max(t.thresholdDb, t.speechDb - EDGE_REFINE_VOICE_MARGIN_DB)
  const frameAt = (s: number): number =>
    framesDb[Math.min(framesDb.length - 1, Math.max(0, Math.floor(s / frameS)))]
  const out = regions.map((r) => ({ ...r }))
  for (const r of out) {
    let ext = 0
    while (r.start > 0 && ext < EDGE_REFINE_MAX_S && frameAt(r.start - frameS / 2) < cutoffDb) {
      r.start = Math.max(0, r.start - frameS)
      ext += frameS
    }
  }
  // Extension can make neighbours touch — merge before handing back.
  out.sort((a, b) => a.start - b.start)
  const merged: typeof out = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push(r)
  }
  return { regions: merged, info: t }
}

export interface RmsPassResult {
  regions: { start: number; end: number }[]
  info: RmsAutoThreshold & { frameS: number; frames: number; raw_runs: number }
}

/**
 * Plan RMS-silence cuts. `words` must be the SAME effective spans the gap pass
 * used (post stretched-word clamp), so both passes agree on where speech is.
 * A low-energy run is cut only where it clears every word guard and each
 * surviving piece is ≥ minSilenceS.
 */
export function planRmsSilence(
  framesDb: number[],
  frameS: number,
  words: SpeechSpan[],
  durationS: number,
  minSilenceS: number
): RmsPassResult {
  const t = rmsAutoThreshold(framesDb)
  const info = { ...t, frameS, frames: framesDb.length, raw_runs: 0 }
  if (!t.usable || !framesDb.length) return { regions: [], info }

  // 1. consecutive sub-threshold frames -> raw low-energy runs (seconds).
  const runs: { start: number; end: number }[] = []
  let runStart = -1
  for (let f = 0; f <= framesDb.length; f++) {
    const low = f < framesDb.length && framesDb[f] < t.thresholdDb
    if (low && runStart < 0) runStart = f
    else if (!low && runStart >= 0) {
      runs.push({ start: runStart * frameS, end: f * frameS })
      runStart = -1
    }
  }
  info.raw_runs = runs.length

  // 2. protected zones: every word span, padded RMS_WORD_GUARD_S per side.
  const guards: { start: number; end: number }[] = []
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start) continue
    const a = Math.max(0, w.start - RMS_WORD_GUARD_S)
    const b = w.end + RMS_WORD_GUARD_S
    const last = guards[guards.length - 1]
    if (last && a <= last.end) last.end = Math.max(last.end, b)
    else guards.push({ start: a, end: b })
  }

  // 3. subtract the guards from each run; keep pieces long enough to matter.
  const regions: { start: number; end: number }[] = []
  for (const r of runs) {
    let cursor = Math.max(0, r.start)
    const end = Math.min(r.end, durationS || r.end)
    for (const g of guards) {
      if (g.end <= cursor) continue
      if (g.start >= end) break
      if (g.start > cursor && g.start - cursor >= minSilenceS) regions.push({ start: cursor, end: g.start })
      cursor = Math.max(cursor, g.end)
    }
    if (end - cursor >= minSilenceS) regions.push({ start: cursor, end })
  }
  return { regions, info }
}

/** Merge any number of cut lists into one sorted, non-overlapping, sm-stamped
 *  region set (the shape the staging/apply pipeline consumes). */
export function unionCutRegions(lists: { start: number; end: number }[][], durationS: number): SilenceRegion[] {
  const all = lists
    .flat()
    .map((c) => ({ start: Math.max(0, c.start), end: durationS > 0 ? Math.min(c.end, durationS) : c.end }))
    .filter((c) => c.end - c.start >= 0.03)
    .sort((a, b) => a.start - b.start)
  const merged: SilenceRegion[] = []
  for (const c of all) {
    const last = merged[merged.length - 1]
    if (last && c.start <= last.end + 0.02) last.end = Math.max(last.end, c.end)
    else merged.push({ id: '', start: c.start, end: c.end, action: 'remove', protect: true })
  }
  return merged.map((r, i) => ({ ...r, id: `sm${i}` }))
}

/**
 * Edge-clamp audio-detected silence regions off transcript word spans: a
 * region EDGE that intrudes into a word is pulled back to guardS outside it,
 * but a word whose span lies ENTIRELY inside a silence region is trusted to
 * the detector (the stamp is an ASR lie — the ear heard nothing there).
 * Regions that vanish (< 0.03s) are dropped. Pure; words need not be sorted.
 */
export function guardRegionEdgesOffWords(
  regions: { start: number; end: number }[],
  words: SpeechSpan[],
  guardS: number
): { start: number; end: number }[] {
  const ws = words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
  const out: { start: number; end: number }[] = []
  for (const r0 of regions) {
    let start = r0.start
    let end = r0.end
    for (const w of ws) {
      const covered = w.start >= start - 1e-6 && w.end <= end + 1e-6
      if (covered) continue // whole word inside silence — trust the detector
      // region end cuts into the word's onset -> stop guardS before the word
      if (end > w.start + 1e-6 && end < w.end && start < w.start) end = Math.max(start, w.start - guardS)
      // region start cuts into the word's tail -> resume guardS after the word
      if (start < w.end - 1e-6 && start > w.start && end > w.end) start = Math.min(end, w.end + guardS)
      // region fully inside a word span -> nothing cuttable here
      if (start >= w.start && end <= w.end && !covered) {
        start = end // collapse
        break
      }
    }
    if (end - start >= 0.03) out.push({ start, end })
  }
  return out
}

/**
 * Shape AUDIO-detected silence regions (Silero) with the user's pads/trims:
 * pads KEEP silence at the region's edges (shrink the cut inward); trims cut
 * PAST the detected edge into speech — trimLeft eats the tail of the sentence
 * ending before the gap, trimRight the onset of the sentence after it. A
 * region touching the media's start keeps its left edge at 0 (nothing speaks
 * before it) and one touching the end keeps its right edge at the end.
 */
export function padTrimRegions(
  regions: { start: number; end: number }[],
  settings: SilenceMasterySettings,
  durationS: number
): { start: number; end: number }[] {
  const s = normalizeSilenceMastery(settings)
  const padL = s.padLeftMs / 1000
  const padR = s.padRightMs / 1000
  const trimL = s.trimLeftMs / 1000
  const trimR = s.trimRightMs / 1000
  const out: { start: number; end: number }[] = []
  for (const r of regions) {
    const atStart = r.start <= 0.01
    const atEnd = durationS > 0 && r.end >= durationS - 0.01
    const a = atStart ? 0 : r.start + padL - trimL
    const b = atEnd ? r.end : r.end - padR + trimR
    const start = Math.max(0, a)
    const end = durationS > 0 ? Math.min(b, durationS) : b
    if (end - start >= 0.03) out.push({ start, end })
  }
  return out
}
