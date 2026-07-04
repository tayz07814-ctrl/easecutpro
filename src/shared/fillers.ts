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

  // 3) Restarted / duplicated SENTENCE: a segment that is a clean prefix of, or a
  //    near-duplicate (>=0.85) of, the very NEXT segment -> the earlier is a
  //    discarded take. Strict + adjacent-only so unrelated sentences aren't cut.
  const seg = t.segments.map((s) => s.words.map((w) => norm(w.text)).filter(Boolean))
  for (let s = 0; s < t.segments.length - 1; s++) {
    const a = seg[s]
    const b = seg[s + 1]
    if (a.length < 4 || b.length < 4) continue
    const isPrefix = a.length < b.length && a.every((w, k) => w === b[k])
    if (isPrefix || seqRatio(a, b) >= 0.9) {
      t.segments[s].words.forEach((w) => ids.add(w.id))
    }
  }

  return [...ids]
}

/** Everything auto-clean removes: fillers + repeats (batch cleaner + MCP). */
export function detectCleanupIds(t: Transcript, list: string[]): string[] {
  return [...new Set([...detectFillerIds(t, list), ...detectRepeatIds(t)])]
}
