/**
 * CutCutPro — pure logic for the 4-phase premium cutting pipeline.
 *
 *   Phase 1  timestamp map      (this file: buildTimestampMap — words + exact
 *                                pauses + fillers + stutters + incomplete
 *                                sentences; whisper-1/VAD run in main)
 *   Phase 2  GPT first pass     (main sends the audio copy to gpt-audio, which
 *                                proposes cuts keeping the LAST take; this file
 *                                builds the payload + validates the EDL)
 *   Phase 3  Claude verify      (main/cutcutpro.ts calls claude-opus-4-8 to
 *                                finalize zero-repeats; this file validates it)
 *   Phase 4  execution          (edlToEdits maps the EDL onto the EXISTING
 *                                model: deleted words + silence regions ->
 *                                computeKeepRanges -> preview/export)
 *
 * PURE: no IO, no APIs — fully headless-testable. Additive: none of the other
 * engines (Detect silence, Fast Cut, Smart cut AI, Smart Smooth Cut) change.
 */
import type { SilenceRegion, Word } from './types'
import { DEFAULT_FILLERS } from './fillers'

// ---------------------------------------------------------------------------
// Phase 1 — timestamp map
// ---------------------------------------------------------------------------

export interface MapPause {
  id: string
  start: number
  end: number
  dur_ms: number
  /** index (into words) of the word BEFORE the pause; -1 = leading air. */
  after_word: number
  /** true when Silero VAD also saw non-speech here (corroborated). */
  vad: boolean
}

export interface TimestampMap {
  words: { i: number; text: string; start: number; end: number }[]
  pauses: MapPause[]
  filler_word_idxs: number[]
  stutter_word_idxs: number[]
  /** sentences left hanging: last word index + the dangling text. */
  incomplete_sentences: { end_word: number; text: string }[]
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9']/g, '')
const ENDS_SENTENCE = /[.!?…]["')\]]*$/

export function buildTimestampMap(words: Word[], vad: { start: number; end: number }[]): TimestampMap {
  const alive = words.filter((w) => !w.deleted)
  const ws = alive.map((w, i) => ({ i, text: w.text, start: w.start, end: w.end }))

  // Exact pauses: every inter-word gap >= 250ms (+ leading air before word 0).
  const pauses: MapPause[] = []
  const overlapsVad = (a: number, b: number): boolean => vad.some((r) => a < r.end && r.start < b)
  let pid = 0
  if (alive.length && alive[0].start >= 0.4) {
    pauses.push({ id: `p${pid++}`, start: 0, end: alive[0].start, dur_ms: Math.round(alive[0].start * 1000), after_word: -1, vad: overlapsVad(0, alive[0].start) })
  }
  for (let i = 0; i < alive.length - 1; i++) {
    const a = alive[i].end
    const b = alive[i + 1].start
    if ((b - a) * 1000 >= 250) {
      pauses.push({ id: `p${pid++}`, start: a, end: b, dur_ms: Math.round((b - a) * 1000), after_word: i, vad: overlapsVad(a, b) })
    }
  }
  // Whisper.cpp word timestamps are typically CONTIGUOUS — a word's span
  // swallows the silence after it, so real pauses hide INSIDE word spans and
  // the gap scan above finds nothing. Anchor each VAD silence to the word whose
  // span it starts in (keeping >=120ms of that word's spoken head) so the AI
  // passes still get every pause even on gap-less transcripts.
  for (const r of vad) {
    if (pauses.some((p) => r.start < p.end && p.start < r.end)) continue // gap scan got it
    let prevIdx = -1
    for (let i = 0; i < alive.length; i++) {
      if (alive[i].start <= r.start + 0.02) prevIdx = i
      else break
    }
    if (prevIdx < 0) continue
    const w = alive[prevIdx]
    const lo = Math.max(r.start, Math.min(w.end, w.start + 0.12))
    const hi = prevIdx + 1 < alive.length ? alive[prevIdx + 1].start : r.end
    const s = Math.max(r.start, lo)
    const e = Math.min(r.end, hi)
    if ((e - s) * 1000 < 250) continue
    pauses.push({ id: `p${pid++}`, start: s, end: e, dur_ms: Math.round((e - s) * 1000), after_word: prevIdx, vad: true })
  }
  pauses.sort((a, b) => a.start - b.start)

  // Vocal fillers (um, uh, like, you know…) from the shared list.
  const fillerSet = new Set(DEFAULT_FILLERS.map(norm))
  const filler_word_idxs = ws.filter((w) => fillerSet.has(norm(w.text))).map((w) => w.i)

  // Stutters: immediate word repeats ("I I", "the the") and cut-off fragments
  // ("th-", "pow—") where the next word completes them.
  const stutter_word_idxs: number[] = []
  for (let i = 0; i < ws.length - 1; i++) {
    const a = norm(ws[i].text)
    const b = norm(ws[i + 1].text)
    if (!a) continue
    if (a === b && a.length <= 8) stutter_word_idxs.push(i)
    else if (/[-–—]$/.test(ws[i].text.trim()) && b.startsWith(a.slice(0, 2))) stutter_word_idxs.push(i)
    else if (a.length >= 2 && a.length < b.length && b.startsWith(a) && b.length - a.length >= 2) {
      // "pow" -> "powerful": fragment abandoned mid-word.
      stutter_word_idxs.push(i)
    }
  }

  // Incomplete sentences: a chunk that ends WITHOUT sentence punctuation right
  // before a long pause (>=600ms) — the speaker abandoned the thought.
  const incomplete_sentences: { end_word: number; text: string }[] = []
  for (const p of pauses) {
    if (p.after_word < 0 || p.dur_ms < 600) continue
    const w = ws[p.after_word]
    if (!ENDS_SENTENCE.test(w.text.trim())) {
      const from = Math.max(0, p.after_word - 6)
      incomplete_sentences.push({ end_word: p.after_word, text: ws.slice(from, p.after_word + 1).map((x) => x.text).join(' ') })
    }
  }

  return { words: ws, pauses, filler_word_idxs, stutter_word_idxs, incomplete_sentences }
}

// ---------------------------------------------------------------------------
// Phase 2/3 — AI payloads + EDL validation
// ---------------------------------------------------------------------------

/** Edit Decision List — the AIs speak in WORD INDICES and PAUSE IDS (never raw
 *  hallucinated timestamps); we resolve them deterministically to time. */
export interface Edl {
  word_cuts: { from: number; to: number; reason: string }[]
  pause_cuts: { pause_id: string; keep_ms: number; reason: string }[]
}

/** Compact, index-anchored transcript view for the AI passes. */
export function buildAiPayload(map: TimestampMap): string {
  const fill = new Set(map.filler_word_idxs)
  const stut = new Set(map.stutter_word_idxs)
  const pauseAfter = new Map(map.pauses.map((p) => [p.after_word, p]))
  const lines: string[] = []
  for (const w of map.words) {
    let line = `${w.i}|${w.text}`
    const tags: string[] = []
    if (fill.has(w.i)) tags.push('FILLER')
    if (stut.has(w.i)) tags.push('STUTTER')
    if (tags.length) line += ` <${tags.join(',')}>`
    lines.push(line)
    const p = pauseAfter.get(w.i)
    if (p) lines.push(`-- ${p.id}: pause ${p.dur_ms}ms${p.vad ? ' (VAD-confirmed silence)' : ''}`)
  }
  const inc = map.incomplete_sentences.map((s) => `word ${s.end_word}: "…${s.text}"`).join('\n')
  return (
    `WORDS (index|text, one per line; pauses marked between):\n${lines.join('\n')}\n\n` +
    (inc ? `INCOMPLETE SENTENCES (left hanging before a pause):\n${inc}\n` : '')
  )
}

/** Parse + clamp an AI EDL reply. Never throws; ok=false means unusable. */
export function validateEdl(raw: string, map: TimestampMap): { ok: boolean; edl: Edl } {
  const empty: Edl = { word_cuts: [], pause_cuts: [] }
  try {
    const cleaned = raw.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim()
    const j = JSON.parse(cleaned)
    const maxI = map.words.length - 1
    const pauseIds = new Set(map.pauses.map((p) => p.id))
    const word_cuts: Edl['word_cuts'] = []
    for (const c of Array.isArray(j?.word_cuts) ? j.word_cuts : []) {
      let from = Math.round(Number(c?.from))
      let to = Math.round(Number(c?.to))
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue
      if (from > to) [from, to] = [to, from]
      from = Math.max(0, Math.min(maxI, from))
      to = Math.max(0, Math.min(maxI, to))
      word_cuts.push({ from, to, reason: String(c?.reason || '') })
    }
    const pause_cuts: Edl['pause_cuts'] = []
    for (const c of Array.isArray(j?.pause_cuts) ? j.pause_cuts : []) {
      const id = String(c?.pause_id)
      if (!pauseIds.has(id)) continue
      const p = map.pauses.find((x) => x.id === id)!
      const k = Number(c?.keep_ms)
      const keep_ms = Number.isFinite(k) ? Math.max(0, Math.min(p.dur_ms - 40, Math.round(k))) : 0
      pause_cuts.push({ pause_id: id, keep_ms, reason: String(c?.reason || '') })
    }
    // Runaway guard: an EDL that deletes most of the speech is a bad reply.
    const cutWords = new Set<number>()
    for (const c of word_cuts) for (let i = c.from; i <= c.to; i++) cutWords.add(i)
    if (map.words.length >= 20 && cutWords.size > map.words.length * 0.6) return { ok: false, edl: empty }
    return { ok: true, edl: { word_cuts, pause_cuts } }
  } catch {
    return { ok: false, edl: empty }
  }
}

// ---------------------------------------------------------------------------
// Post-EDL refinement — deterministic guards over the AI's judgment.
//
// Screenshot-verified failure family: the AI cuts only the TAIL of an
// abandoned take, leaving its duplicated opening (or a dangling half-clause)
// in the kept audio:
//   "But I wish I grabbed two because [cut: I have to wait a freaking.]
//    I wish I grabbed two because I literally…"        -> duplicated opening
//   "…affordable because it smell so [cut: freaking.] It smells so good…"
//                                                      -> dangling fragment
//   "Like, do not be surprised [cut: if you're got or do] not be surprised…"
//                                                      -> boundary one word off
// Two pure passes fix all three:
//   (1) boundary dedupe: if kept words BEFORE a cut re-say the opening of the
//       kept words AFTER it (>=2-token prefix), extend the cut backward over
//       the doomed earlier copy (same idea as FastCut's backward extension);
//   (2) fragment sweep: if a mapped INCOMPLETE sentence lost its continuation
//       to a cut, cut the whole broken clause (back to the previous sentence
//       end) instead of leaving "…because it smell so" hanging.
// A runaway guard reverts everything if refinement would cut >60% of words.
// ---------------------------------------------------------------------------

function mergeWordCuts(cuts: Edl['word_cuts']): Edl['word_cuts'] {
  const sorted = [...cuts].sort((a, b) => a.from - b.from)
  const out: Edl['word_cuts'] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.from <= last.to + 1) {
      last.to = Math.max(last.to, c.to)
      if (c.reason && !last.reason.includes(c.reason)) last.reason = `${last.reason}; ${c.reason}`.slice(0, 300)
    } else {
      out.push({ ...c })
    }
  }
  return out
}

export function refineEdl(edl: Edl, map: TimestampMap): { edl: Edl; notes: string[] } {
  const notes: string[] = []
  const W = map.words
  if (!W.length || !edl.word_cuts.length) return { edl, notes }
  const tok = W.map((w) => norm(w.text))
  const endsSentence = (i: number): boolean => ENDS_SENTENCE.test(W[i].text.trim())

  let cuts = mergeWordCuts(edl.word_cuts)
  const inCut = (i: number, list = cuts): boolean => list.some((c) => i >= c.from && i <= c.to)

  // ---- pass 1: boundary dedupe / backward extension --------------------------
  for (let sweep = 0; sweep < 4; sweep++) {
    let changed = false
    for (const c of cuts) {
      // kept tokens AFTER the cut (the surviving take's opening)
      const after: number[] = []
      for (let i = c.to + 1; i < W.length && after.length < 6; i++) if (!inCut(i)) after.push(i)
      // kept tokens BEFORE the cut (potential doomed opening)
      const before: number[] = []
      for (let i = c.from - 1; i >= 0 && before.length < 10; i--) if (!inCut(i)) before.unshift(i)
      if (after.length < 2 || before.length < 1) continue
      // longest match of after's opening found inside before
      let bestS = -1
      let bestN = 0
      for (let s = 0; s < before.length; s++) {
        let n = 0
        while (n < after.length && s + n < before.length && tok[before[s + n]] === tok[after[n]] && tok[after[n]]) n++
        if (n >= 2 && n > bestN) {
          bestN = n
          bestS = s
        }
      }
      if (bestS >= 0 && c.from - before[bestS] <= 12) {
        notes.push(
          `dedupe: extended cut back over duplicated opening "${before.slice(bestS).map((i) => W[i].text).join(' ')}" (re-said after the cut)`
        )
        c.from = before[bestS]
        changed = true
      }
    }
    cuts = mergeWordCuts(cuts)
    if (!changed) break
  }

  // ---- pass 2: incomplete-fragment sweep --------------------------------------
  for (const inc of map.incomplete_sentences) {
    const e = inc.end_word
    if (e < 0 || e >= W.length || inCut(e)) continue
    // the fragment's continuation (next 1-2 words) was cut away -> it dangles
    const next = [e + 1, e + 2].filter((i) => i < W.length)
    if (!next.some((i) => inCut(i))) continue
    const cut = cuts.find((c) => next.some((i) => i >= c.from && i <= c.to))
    if (!cut) continue
    // clause start: just after the previous sentence end (within 20 kept words)
    let start = -1
    for (let i = e - 1, steps = 0; i >= 0 && steps < 20; i--, steps++) {
      if (inCut(i)) continue
      if (endsSentence(i)) {
        start = i + 1
        break
      }
      if (i === 0) start = 0
    }
    if (start < 0 || start > e) continue
    if (cut.from > start) {
      notes.push(`fragment: cut the whole broken clause "${W.slice(start, e + 1).map((w) => w.text).join(' ')}" (its continuation was cut)`)
      cut.from = Math.min(cut.from, start)
    }
  }
  cuts = mergeWordCuts(cuts)

  // ---- runaway guard ----------------------------------------------------------
  // Each extension is individually bounded (dedupe <=12 words, fragment <=20) and
  // evidence-backed, so a legit sweep on a SHORT clip can exceed 60% — only a
  // near-total wipe indicates something went wrong.
  const cutCount = cuts.reduce((s, c) => s + (c.to - c.from + 1), 0)
  if (W.length >= 20 && cutCount > W.length * 0.85) {
    return { edl, notes: [`refinement reverted: would cut ${cutCount}/${W.length} words (>85%)`] }
  }
  return { edl: { word_cuts: cuts, pause_cuts: edl.pause_cuts }, notes }
}

// ---------------------------------------------------------------------------
// Phase 4 — resolve the EDL onto the existing edit model
// ---------------------------------------------------------------------------

export function edlToEdits(
  edl: Edl,
  map: TimestampMap,
  words: Word[]
): { deleteWordIds: string[]; silenceAdds: SilenceRegion[] } {
  const alive = words.filter((w) => !w.deleted)
  const del = new Set<string>()
  for (const c of edl.word_cuts) {
    for (let i = c.from; i <= c.to && i < alive.length; i++) del.add(alive[i].id)
  }
  const byId = new Map(map.pauses.map((p) => [p.id, p]))
  const silenceAdds: SilenceRegion[] = []
  let n = 0
  for (const c of edl.pause_cuts) {
    const p = byId.get(c.pause_id)
    if (!p) continue
    if (c.keep_ms >= p.dur_ms - 60) continue // nothing meaningful to trim
    if (c.keep_ms <= 0) {
      // Full removal still leaves a tiny 80ms breath pad so speech never clips.
      const s = p.start + 0.08
      const e = p.end - 0.08
      if (e - s < 0.08) continue
      silenceAdds.push({ id: `ccp-${++n}-${p.id}`, start: s, end: e, action: 'remove' })
    } else {
      silenceAdds.push({ id: `ccp-${++n}-${p.id}`, start: p.start, end: p.end, action: 'shorten', shortenTo: c.keep_ms / 1000 })
    }
  }
  silenceAdds.sort((a, b) => a.start - b.start)
  return { deleteWordIds: [...del], silenceAdds }
}

/** Debug record persisted for every run (why each cut happened). */
export interface CutCutProDebug {
  mode: 'cutcutpro'
  phases_run: string[]
  timestamp_map: TimestampMap
  claude_edl: Edl | null
  openai_edl: Edl | null
  final_edl: Edl
  /** what the deterministic post-EDL guards changed (dedupe/fragment sweep). */
  refine_notes?: string[]
  deleted_words: number
  pause_edits: number
  warnings: string[]
}

export interface CutCutProResult {
  /** set when the pipeline transcribed (project had no transcript). */
  transcript: import('./types').Transcript | null
  deleteWordIds: string[]
  silenceAdds: SilenceRegion[]
  debugPath: string
  warnings: string[]
  summary: string
}
