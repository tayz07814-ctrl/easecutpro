// Smart Silence Cleaner — the engine. Transcript timestamps in, cut list out.
//
// Faithful port of smart_silence_cleaner/engine/silence_engine.py. No audio
// analysis, no I/O. One public entry point: `planSilence`.
//
// The rule set (mirrors the product spec exactly):
//
// 1. For each pair of adjacent KEPT words: gap = next.start - cur.end.
// 2. gap <= minGap            -> keep it (natural rhythm, untouched).
// 3. gap  > minGap            -> trim down to a target, never to zero:
//        removed = gap - target      (900ms gap, 180ms target -> remove 720ms)
// 4. Target depends on Smart Silence:
//      * ON + Keep Sentence Flow -> punctuation aware: longer after `. ? !`,
//        medium after `,`, else the plain target.
//      * OFF                     -> every over-threshold gap trimmed to the
//        single targetPauseMs (plain gap-based, no punctuation).
// 5. The kept `target` is split SYMMETRICALLY — half retained right after the
//    current word, half right before the next — so the removed chunk is centred
//    in the gap. padBefore + padAfter set a floor on how short the kept pause
//    may be (min_keep), never letting two words butt together.
// 6. Remove Filler Words deletes uh/um/you know/… by dropping them from the
//    kept list so the silence around them collapses into one trim.
// 7. mergeGap fuses cuts separated only by a tiny silent sliver.

import * as config from './config'
import { endsClause, endsSentence, isSingleFiller, wordClean } from './config'
import { computeStats } from './stats'
import type { Cut, CutReason, SilencePlan, SilenceSettings, Word } from './types'

// --------------------------------------------------------------------------- //
// public                                                                      //
// --------------------------------------------------------------------------- //

/**
 * Compute the full cut plan for `words` under `settings`.
 *
 * @param words             The transcript in order. Empty input -> empty plan.
 * @param settings          The knobs (see SilenceSettings).
 * @param originalDurationMs Media length. Defaults to the last word's end.
 */
export function planSilence(
  words: Word[],
  settings: SilenceSettings,
  originalDurationMs?: number,
): SilencePlan {
  const valid = words.filter((w) => w.endMs >= w.startMs)
  if (valid.length === 0) return emptyPlan(originalDurationMs ?? 0.0)

  const last = valid[valid.length - 1]
  let duration = originalDurationMs !== undefined ? originalDurationMs : last.endMs
  duration = Math.max(duration, last.endMs)

  const fillerIdx = settings.removeFillers ? fillerIndices(valid) : new Set<number>()
  const fillerSpans: Array<[number, number]> = [...fillerIdx]
    .sort((a, b) => a - b)
    .map((i) => [valid[i].startMs, valid[i].endMs])

  // Words the viewer actually hears — fillers dropped so the gap bracketing
  // them (word -> filler(s) -> word) collapses into one trim.
  const kept = valid.filter((_, i) => !fillerIdx.has(i))

  const rawCuts = gapCuts(kept, settings, fillerSpans)
  const cuts = merge(rawCuts, settings.mergeGapMs)

  const keeps = complement(cuts, duration)
  const totalRemoved = cuts.reduce((acc, c) => acc + c.removedMs, 0.0)

  const stats = computeStats(valid, totalRemoved, cuts.length, fillerIdx.size, duration)
  return { cuts, keeps, stats, originalDurationMs: duration }
}

// --------------------------------------------------------------------------- //
// gap trimming                                                                //
// --------------------------------------------------------------------------- //

/** One trim per over-threshold gap between consecutive kept words. */
function gapCuts(
  kept: Word[],
  s: SilenceSettings,
  fillerSpans: Array<[number, number]>,
): Cut[] {
  const cuts: Cut[] = []
  for (let i = 0; i < kept.length - 1; i++) {
    const cur = kept[i]
    const nxt = kept[i + 1]
    const gap = nxt.startMs - cur.endMs
    if (gap <= s.minGapMs) continue // below threshold — natural pause, keep whole

    let target = targetFor(cur, s)
    // A kept pause can never be shorter than the protected pads, nor longer
    // than the gap itself.
    const minKeep = s.padBeforeMs + s.padAfterMs
    target = Math.min(gap, Math.max(target, minKeep, config.MIN_KEPT_PAUSE_MS))
    const removed = gap - target
    if (removed < config.MIN_MEANINGFUL_TRIM_MS) continue // not worth a splice

    // SYMMETRIC trim: keep half the target pause on EACH side of the cut
    // (silence retained right after the current word AND right before the next
    // word) so the join reads naturally, instead of biasing all the kept air to
    // one edge. The removed chunk is centred in the gap.
    const keepEach = target / 2.0
    const cutStart = cur.endMs + keepEach
    const cutEnd = nxt.startMs - keepEach
    // numeric safety: stay strictly inside the gap
    if (cutEnd <= cutStart || cutEnd - cutStart < config.MIN_MEANINGFUL_TRIM_MS) continue

    const reason: CutReason = fillerSpans.some(([fs, fe]) => fs < cutEnd && fe > cutStart)
      ? 'filler'
      : 'gap'
    cuts.push({ startMs: cutStart, endMs: cutEnd, removedMs: cutEnd - cutStart, reason })
  }
  return cuts
}

/** Pick the pause length to KEEP after `cur`. */
function targetFor(cur: Word, s: SilenceSettings): number {
  if (s.smartSilence && s.keepSentenceFlow) {
    if (endsSentence(cur)) return s.sentencePauseMs
    if (endsClause(cur)) return s.commaPauseMs
  }
  return s.targetPauseMs
}

// --------------------------------------------------------------------------- //
// fillers                                                                     //
// --------------------------------------------------------------------------- //

/** Indices of filler tokens — single words and known phrases. */
function fillerIndices(words: Word[]): Set<number> {
  const idx = new Set<number>()
  const cleans = words.map(wordClean)

  // phrases first (mark every token of a matched phrase)
  for (let start = 0; start < words.length; start++) {
    for (const phrase of config.PHRASE_FILLERS) {
      const end = start + phrase.length
      if (end <= words.length) {
        let match = true
        for (let k = 0; k < phrase.length; k++) {
          if (cleans[start + k] !== phrase[k]) {
            match = false
            break
          }
        }
        if (match) for (let k = start; k < end; k++) idx.add(k)
      }
    }
  }

  // single-word fillers
  for (let i = 0; i < words.length; i++) {
    if (isSingleFiller(words[i])) idx.add(i)
  }
  return idx
}

// --------------------------------------------------------------------------- //
// merge + complement                                                          //
// --------------------------------------------------------------------------- //

/** Fuse overlapping cuts, or cuts separated by a silent sliver < mergeGap. */
function merge(cuts: Cut[], mergeGapMs: number): Cut[] {
  if (cuts.length === 0) return []
  const ordered = [...cuts].sort((a, b) => a.startMs - b.startMs)
  const out: Cut[] = [ordered[0]]
  for (let i = 1; i < ordered.length; i++) {
    const c = ordered[i]
    const last = out[out.length - 1]
    if (c.startMs - last.endMs <= Math.max(0.0, mergeGapMs)) {
      const start = last.startMs
      const end = Math.max(last.endMs, c.endMs)
      const reason: CutReason = last.reason === 'filler' || c.reason === 'filler' ? 'filler' : 'gap'
      out[out.length - 1] = { startMs: start, endMs: end, removedMs: end - start, reason }
    } else {
      out.push(c)
    }
  }
  return out
}

/** The KEEP ranges = [0, duration] minus every cut. */
function complement(cuts: Cut[], durationMs: number): Array<[number, number]> {
  const keeps: Array<[number, number]> = []
  let cursor = 0.0
  for (const c of cuts) {
    if (c.startMs > cursor) keeps.push([cursor, c.startMs])
    cursor = Math.max(cursor, c.endMs)
  }
  if (durationMs > cursor) keeps.push([cursor, durationMs])
  return keeps
}

// --------------------------------------------------------------------------- //

function emptyPlan(durationMs: number): SilencePlan {
  const stats = computeStats([], 0.0, 0, 0, durationMs)
  const keeps: Array<[number, number]> = durationMs > 0 ? [[0.0, durationMs]] : []
  return { cuts: [], keeps, stats, originalDurationMs: durationMs }
}
