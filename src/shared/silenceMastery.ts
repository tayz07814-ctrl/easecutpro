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
  /** cut extended INTO the neighbouring word timestamps on both sides (ms). */
  trimEdgesMs: number
}

export const DEFAULT_SILENCE_MASTERY_SETTINGS: SilenceMasterySettings = {
  minSilenceS: 0.5,
  padLeftMs: 100,
  padRightMs: 100,
  trimEdgesMs: 0
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
    trimEdgesMs: clampN(v?.trimEdgesMs, 0, 300, d.trimEdgesMs)
  }
}

export interface SpeechSpan {
  /** seconds, source time. */
  start: number
  end: number
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
  const s = normalizeSilenceMastery(settings)
  const padL = s.padLeftMs / 1000
  const padR = s.padRightMs / 1000
  const trim = s.trimEdgesMs / 1000
  const MIN_CUT_S = 0.03 // a cut narrower than a frame is noise — drop it

  const ws = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start)

  const cuts: { start: number; end: number }[] = []
  // A cut's edges: pad pulls inward from the gap boundary, trim pushes outward
  // into the word — they oppose each other, so the effective offset is
  // (pad − trim), clamped so the cutter never passes a word's midpoint.
  const leftEdge = (prev: SpeechSpan | null, gapStart: number): number =>
    prev ? Math.max(wordFloor(prev), gapStart + padL - trim) : Math.max(0, gapStart)
  const rightEdge = (next: SpeechSpan | null, gapEnd: number): number =>
    next ? Math.min(wordFloor(next), gapEnd - padR + trim) : gapEnd

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
    // Inter-word gaps. Words can overlap or touch (ASR quirks) — only a raw
    // gap ≥ minSilenceS becomes a cut.
    for (let i = 0; i < ws.length - 1; i++) {
      const prev = ws[i]
      const next = ws[i + 1]
      const gapStart = prev.end
      const gapEnd = next.start
      if (gapEnd - gapStart < s.minSilenceS) continue
      const a = leftEdge(prev, gapStart)
      const b = rightEdge(next, gapEnd)
      if (b - a >= MIN_CUT_S) cuts.push({ start: a, end: b })
    }
    // Trailing silence: last word → end of media. No pad on the right.
    const last = ws[ws.length - 1]
    if (durationS - last.end >= s.minSilenceS) {
      const a = leftEdge(last, last.end)
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
  return merged.map((r, i) => ({ ...r, id: `sm${i}` }))
}
