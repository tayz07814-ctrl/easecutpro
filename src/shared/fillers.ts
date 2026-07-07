// Filler + repeat/retake detection over a transcript. Shared by the editor
// (Remove fillers / Remove repeats buttons), the batch cleaner, and the MCP
// server. Split into two detectors so the UI can offer them separately:
//   detectFillerIds  — filler words/phrases only (um, uh, like, you know…)
//   detectRepeatIds  — stutters, restarts, repeated/re-recorded sentences (fuzzy)
//   detectCleanupIds — union of both (what auto-clean removes)
import type { Transcript } from './types'

export const DEFAULT_FILLERS = [
  'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'err', 'ah', 'hmm', 'mm', 'mhm', 'eh',
  'like', 'basically', 'actually', 'literally', 'honestly',
  'you know', 'i mean', 'sort of', 'kind of'
]

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z']/g, '')

/** Pure hesitation sounds — the only words allowed to sit BETWEEN two retake takes. */
const HESITATION = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'err', 'ah', 'hmm', 'mm', 'mhm', 'mhmm', 'eh'])

/** Word ids that are filler words/phrases from `list` (um, uh, you know, …). */
export function detectFillerIds(t: Transcript, list: string[]): string[] {
  const SINGLES = new Set(list.filter((f) => !f.includes(' ')).map((f) => norm(f)).filter(Boolean))
  const PHRASES = list
    .filter((f) => f.includes(' '))
    .map((f) => f.trim().toLowerCase().split(/\s+/).map(norm).filter(Boolean))
    .filter((p) => p.length > 1)

  const words = t.words
  const ids = new Set<string>()

  // Single-word fillers.
  words.forEach((w) => {
    if (SINGLES.has(norm(w.text))) ids.add(w.id)
  })
  // Multi-word filler phrases.
  for (let i = 0; i < words.length; i++) {
    for (const ph of PHRASES) {
      if (i + ph.length <= words.length && ph.every((p, k) => norm(words[i + k].text) === p)) {
        for (let k = 0; k < ph.length; k++) ids.add(words[i + k].id)
      }
    }
  }
  return [...ids]
}

// ---- Fuzzy sequence helpers (so slightly-different retakes still match) ----
/** Length of the longest common subsequence of two token arrays. */
function lcsLen(a: string[], b: string[]): number {
  const n = b.length
  if (!a.length || !n) return 0
  const dp = new Array<number>(n + 1).fill(0)
  for (let i = 0; i < a.length; i++) {
    let prev = 0
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = a[i] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1])
      prev = tmp
    }
  }
  return dp[n]
}
/** 0..1 similarity of two token sequences (Dice coefficient over the LCS). */
function seqRatio(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  return (2 * lcsLen(a, b)) / (a.length + b.length)
}

// ---- clause-level retake detection (keep the LAST take) -------------------
// Real retakes VARY: the last take adds/reorders words ("definitely"), the first
// take is padded with stutters/false-starts ("uh uh the the uh because your your
// uh"). A symmetric similarity punishes exactly that shape, so we ask a directional
// question: "is the LAST take mostly an ordered subset of the earlier one?"
// (containment = LCS(earlier,last)/len(last)). When yes, the earlier clause is a
// discarded take -> cut the WHOLE clause, keep the whole last take. This replaces
// the old strict ">=0.90 adjacent-segment" rule that missed varied retakes and left
// only the shared middle words flagged (the broken fragments).

const PAUSE_GAP = 0.35 // s — a gap this long splits a clause even without punctuation
const CONTAIN_MIN = 0.7 // fraction of the LAST take covered (in order) by the earlier
const NEARDUP_MIN = 0.82 // symmetric near-duplicate ratio (lowered from 0.90)
const MIN_CONTENT = 3 // min non-hesitation tokens for a clause to count as a take
const MAX_RETAKE_GAP = 4 // s — takes farther apart in time aren't a retake

/** A clause = a word-index range [from,to); `content` = normalized non-hesitation tokens. */
interface Clause {
  from: number
  to: number
  content: string[]
  /** word index of each content token (content[k] came from words[contentIdx[k]]). */
  contentIdx: number[]
}

/** Split words into clauses on sentence punctuation OR a pause — so two takes
 *  separate even when whisper put no period between them. */
function buildClauses(t: Transcript): Clause[] {
  const w = t.words
  const out: Clause[] = []
  let start = 0
  const push = (a: number, b: number): void => {
    if (b <= a) return
    const content: string[] = []
    const contentIdx: number[] = []
    for (let j = a; j < b; j++) {
      const nrm = norm(w[j].text)
      if (nrm && !HESITATION.has(nrm)) {
        content.push(nrm)
        contentIdx.push(j)
      }
    }
    out.push({ from: a, to: b, content, contentIdx })
  }
  for (let i = 0; i < w.length; i++) {
    const endsSentence = /[.!?…]["')\]]*$/.test(w[i].text.trim())
    const gapAfter = i + 1 < w.length ? w[i + 1].start - w[i].end : 0
    if (endsSentence || gapAfter >= PAUSE_GAP || i === w.length - 1) {
      push(start, i + 1)
      start = i + 1
    }
  }
  return out
}

/** How `b` relates to the earlier `a`:
 *  - 'whole'  — a IS a take of b (near-duplicate, or containment on a clause of
 *               comparable size): discard ALL of a;
 *  - 'tail'   — a is a LONG clause whose trailing words are a take of b (the
 *               speaker rambled on and only restarted the ENDING): discard only
 *               the aligned tail, `tailFromWord` onward. Cutting the whole
 *               clause here nuked 30+ words of unique content because the one
 *               rambling sentence had no interior punctuation (perfume clip,
 *               2026-07-07);
 *  - null     — not a retake.
 */
function retakeMatch(a: Clause, b: Clause): { kind: 'whole' } | { kind: 'tail'; tailFromWord: number } | null {
  if (a.content.length < MIN_CONTENT || b.content.length < MIN_CONTENT) return null
  const contain = lcsLen(a.content, b.content) / b.content.length
  const neardup = seqRatio(a.content, b.content) >= NEARDUP_MIN
  if (neardup) return { kind: 'whole' }
  if (contain < CONTAIN_MIN) return null
  // comparable sizes -> the whole clause is the earlier take (original rule)
  if (a.content.length <= Math.ceil(1.8 * b.content.length)) return { kind: 'whole' }
  // long clause: find the SMALLEST suffix that still contains b. If no suffix
  // of reasonable size (≤2.2×) reaches the bar, the matching words are spread
  // through unrelated content — an incidental match, not a retake.
  const maxTail = Math.ceil(2.2 * b.content.length)
  for (let s = Math.max(0, a.content.length - b.content.length); s >= 0; s--) {
    const suffix = a.content.slice(s)
    if (suffix.length > maxTail) break
    if (lcsLen(suffix, b.content) / b.content.length >= CONTAIN_MIN) {
      return { kind: 'tail', tailFromWord: a.contentIdx[s] }
    }
  }
  return null
}

/** Classify clauses into discarded EARLIER takes (cut whole) and surviving LAST
 *  takes (protect). Keep-last: across a run of retakes only the final one survives. */
function retakeClauses(t: Transcript): {
  clauses: Clause[]
  cut: Set<number>
  /** partial cuts: only the TAIL of a long clause is a retake — [from,to) word range. */
  cutRanges: { from: number; to: number }[]
  kept: Set<number>
} {
  const clauses = buildClauses(t)
  const w = t.words
  const cut = new Set<number>()
  const cutRanges: { from: number; to: number }[] = []
  const kept = new Set<number>()
  // content clauses only (skip filler-only bridges), in order.
  const content = clauses.map((c, i) => ({ c, i })).filter((x) => x.c.content.length >= MIN_CONTENT)
  for (let k = 0; k < content.length - 1; k++) {
    const A = content[k]
    const B = content[k + 1]
    const gap = w[B.c.from].start - w[A.c.to - 1].end // time between the two takes
    if (gap > MAX_RETAKE_GAP) continue
    const m = retakeMatch(A.c, B.c)
    if (!m) continue
    if (m.kind === 'whole') {
      cut.add(A.i)
      for (let j = A.i + 1; j < B.i; j++) cut.add(j) // filler-only clauses go with the discarded take
    } else {
      cutRanges.push({ from: m.tailFromWord, to: A.c.to })
      for (let j = A.i + 1; j < B.i; j++) cut.add(j)
    }
    kept.add(B.i) // provisional — cleared below if B is itself an earlier take
  }
  for (const i of cut) kept.delete(i)
  return { clauses, cut, cutRanges, kept }
}

/**
 * Clean an arbitrary flag set (e.g. the FastCut union of the Python engine +
 * detectRepeatIds) into whole-clause cuts using the retake structure:
 *  - add every word of a discarded earlier take,
 *  - expand a mostly-flagged normal clause to the WHOLE clause (turns leftover
 *    fragments into a clean cut), but never the surviving last take,
 *  - protect the surviving last take: drop stray fragment flags there, keeping
 *    only genuine immediate stutters.
 * Pure. Used to stop broken half-sentence cuts on retake-heavy footage.
 */
export function snapRetakeFlags(ids: string[], t: Transcript): string[] {
  const w = t.words
  const { clauses, cut, cutRanges, kept } = retakeClauses(t)
  const flagged = new Set(ids)
  // 1) whole discarded takes + the retaken TAILS of long clauses.
  for (const idx of cut) for (let j = clauses[idx].from; j < clauses[idx].to; j++) flagged.add(w[j].id)
  for (const r of cutRanges) for (let j = r.from; j < r.to; j++) flagged.add(w[j].id)
  // 2) expand a mostly-flagged NORMAL clause to whole (fragment -> clean cut).
  for (let ci = 0; ci < clauses.length; ci++) {
    if (cut.has(ci) || kept.has(ci)) continue
    const c = clauses[ci]
    const total = c.to - c.from
    if (total < MIN_CONTENT) continue
    let f = 0
    for (let j = c.from; j < c.to; j++) if (flagged.has(w[j].id)) f++
    if (f / total >= 0.5) for (let j = c.from; j < c.to; j++) flagged.add(w[j].id)
  }
  // 3) protect the surviving last take: keep only immediate stutters flagged.
  for (const ci of kept) {
    const c = clauses[ci]
    const stutter = new Set<string>()
    for (let j = c.from + 1; j < c.to; j++) {
      const a = norm(w[j].text)
      if (a && a === norm(w[j - 1].text)) stutter.add(w[j - 1].id)
    }
    for (let j = c.from; j < c.to; j++) if (flagged.has(w[j].id) && !stutter.has(w[j].id)) flagged.delete(w[j].id)
  }
  return [...flagged]
}

/**
 * Word ids that are REPEATS / discarded extra takes — PRECISE (won't flag
 * unrelated sentences that merely share a few words):
 *  - stutters (a word said twice in a row),
 *  - adjacent retakes: a run of >=3 words repeated right away (a couple of filler
 *    words between is fine; 1 typo tolerated on long runs) -> cut the FIRST take,
 *    keep the last. Handles "see most people see most people" and growing retakes
 *    ("this is the strong— this is the strongest dark spot remover"),
 *  - a sentence that is a clean prefix / near-duplicate of the very NEXT sentence.
 */
export function detectRepeatIds(t: Transcript): string[] {
  const words = t.words
  const ids = new Set<string>()
  const A = words.map((w) => norm(w.text))
  const n = A.length

  // 1) Stutter: an identical word twice in a row -> cut the earlier.
  for (let i = 1; i < n; i++) {
    if (A[i] && A[i] === A[i - 1]) ids.add(words[i - 1].id)
  }

  // 2) Adjacent (near-)duplicate phrase repeated immediately -> cut the first take
  //    (+ any filler words between the takes). Longest match first so growing/partial
  //    retakes collapse to the most complete final take. 2-word phrases only count
  //    when IMMEDIATELY adjacent + exact (catches "all I all I" stutters safely).
  const MINLEN = 2
  const MAXLEN = 15
  const MAXGAP = 2 // filler/pause words tolerated between the two takes
  let i = 0
  while (i < n) {
    let hit = false
    for (let L = Math.min(MAXLEN, (n - i) >> 1); L >= MINLEN && !hit; L--) {
      for (let gap = 0; gap <= MAXGAP && !hit; gap++) {
        const j = i + L + gap
        if (j + L > n) continue
        // The gap between takes is only bridgeable if it's pure hesitation (um/uh).
        // A real word there (and/if/but/so) means continuing speech, not a retake.
        let bridgeable = true
        for (let g = 0; g < gap; g++) if (!HESITATION.has(A[i + L + g])) { bridgeable = false; break }
        if (!bridgeable) continue
        let miss = 0
        let ok = true
        for (let k = 0; k < L; k++) {
          if (!A[i + k] || !A[j + k]) {
            ok = false
            break
          }
          if (A[i + k] !== A[j + k]) miss++
        }
        // Both takes must START and END with the same word — a differing boundary
        // means two distinct sentences, not a retake (only interior typos allowed).
        // 2-word matches must be IMMEDIATELY adjacent (gap 0) — no hesitation-gap
        // bridging for such short phrases, which would over-flag.
        if (ok && (L >= 3 || gap === 0) && A[i] === A[j] && A[i + L - 1] === A[j + L - 1] && miss <= (L >= 5 ? 1 : 0)) {
          for (let x = i; x < i + L + gap; x++) ids.add(words[x].id)
          i = j // keep scanning from the surviving take
          hit = true
        }
      }
    }
    if (!hit) i++
  }

  // 3) Clause-level retakes: cut the WHOLE earlier take, keep the last (see
  //    retakeClauses — containment + pause segmentation). Replaces the old strict
  //    >=0.90 adjacent-segment rule that missed varied retakes and left fragments.
  const { clauses, cut, cutRanges } = retakeClauses(t)
  for (const idx of cut) for (let j = clauses[idx].from; j < clauses[idx].to; j++) ids.add(words[j].id)
  for (const r of cutRanges) for (let j = r.from; j < r.to; j++) ids.add(words[j].id)

  return [...ids]
}

/** Everything auto-clean removes: fillers + repeats (batch cleaner + MCP). */
export function detectCleanupIds(t: Transcript, list: string[]): string[] {
  return [...new Set([...detectFillerIds(t, list), ...detectRepeatIds(t)])]
}
