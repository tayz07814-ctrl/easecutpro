// Retake-Aware Cut Beta — the PURE rule engine (no IO, no providers, no app
// state), so every decision is unit-testable offline. The orchestrator in
// src/main/retakeaware/engine.ts feeds it a VerbatimTranscript and turns its
// output into cut spans + review flags.
//
// Core rule, enforced structurally: repeated attempts are grouped as CHUNKS
// and resolved by keeping EXACTLY ONE whole attempt — removal spans always
// cover an attempt's full word range, so words from different takes can never
// be spliced together.

import type {
  VerbatimTranscript,
  VerbatimWord,
  Chunk,
  FillerDecision,
  FillerClass,
  RetakeAttempt,
  RetakeGroup,
  RepetitionCandidate,
  RejectedCandidate,
  TailCut,
  MissedCutoff,
  CutSpan,
  LlmDecisions
} from './types'

// ---- tuning ----
const CHUNK_GAP_S = 0.55 // a pause this long ends a sentence-ish chunk
const CHUNK_MAX_WORDS = 26 // fallback split for run-on speech
const RETAKE_WINDOW_S = 25 // compare chunks whose gap is at most this
const RETAKE_MAX_LOOKAHEAD = 4 // ... and at most this many chunks apart
const SIM_THRESHOLD = 0.55 // similarity for "same line, retried"
const AMBIG_SIM = 0.35 // below this a pair is noise; between = LLM-reviewed
const PREFIX_RETAKE_MIN = 5 // shared-opening tokens for a prefix-swap retake
const MIN_PREFIX_TOKENS = 2 // retakes share how they START
const PAD_S = 0.04 // safe padding around cut spans
const MERGE_GAP_S = 0.12 // spans closer than this merge
const MIN_SPAN_S = 0.12 // never emit micro-cuts
const FALSE_START_MIN_PAUSE_MS = 400 // dash tail must be followed by real air
const STUTTER_MAX_GAP_S = 1.1 // max pause at the SEAM of a same-breath stutter restart
const FALSE_START_MAX_TAIL = 8 // never tail-cut more than this many words
/** cut-off marker AssemblyAI writes on abandoned words: "need—", "my—". */
const DASH_RE = /[—–-]["')\]]?\s*$/
const CORRECTION_MARKERS = new Set(['or', 'sorry', 'no', 'wait'])
const LEADING_CONNECTIVES = new Set(['and', 'or', 'but', 'so', 'then', 'plus', 'also'])
// Closed-class function words: doubling one of these back-to-back is almost
// always a stutter, never emphasis (unlike a doubled CONTENT word — "never,
// never", "so good, so good" — which stays). Deliberately conservative:
// ambiguous connectives that ARE sometimes doubled for emphasis ("so, so
// good") are left out.
const STUTTER_PRONE_SINGLE = new Set(['i', 'you', 'he', 'she', 'we', 'they', 'it', 'because', 'and', 'but'])

// Hesitations: candidates for removal (never automatic keepers).
const HESITATIONS = new Set(['uh', 'um', 'er', 'ah', 'erm', 'mm', 'hmm', 'uhh', 'umm', 'mhm'])
// Discourse words: natural fillers — KEEP by default, remove only in ugly clusters.
const DISCOURSE = new Set(['like', 'basically', 'actually', 'honestly', 'literally', 'well', 'so'])
const DISCOURSE_PHRASES = [
  ['you', 'know'],
  ['i', 'mean'],
  ['sort', 'of'],
  ['kind', 'of']
]
// Spoken editing commands: the attempt before them is almost certainly a flub.
const RETAKE_MARKERS = [
  ['no', 'wait'],
  ['wait', 'no'],
  ['let', 'me', 'say', 'that', 'again'],
  ['let', 'me', 'try', 'that', 'again'],
  ['let', 'me', 'start', 'over'],
  ['start', 'over'],
  ['scratch', 'that'],
  ['take', 'two'],
  ['one', 'more', 'time'],
  ['say', 'that', 'again']
]

export function normToken(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
}

function isHesitation(w: VerbatimWord): boolean {
  return HESITATIONS.has(normToken(w.word))
}

// ---- 1. chunking (utterances > pauses/punctuation > max length) ----
export function buildChunks(vt: VerbatimTranscript): Chunk[] {
  const words = vt.words
  if (!words.length) return []
  const boundaries: number[] = [] // index of the LAST word of each chunk
  // Provider utterance ends become preferred boundaries.
  const uttEnds = new Set<number>()
  for (const u of vt.utterances) {
    let last = -1
    for (let i = 0; i < words.length; i++) if (words[i].end <= u.end + 0.02) last = i
    if (last >= 0) uttEnds.add(last)
  }
  let chunkStart = 0
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1]
    const gap = next ? next.start - words[i].end : Infinity
    const punct = /[.!?]["')\]]?$/.test(words[i].word.trim())
    const tooLong = i - chunkStart + 1 >= CHUNK_MAX_WORDS
    if (!next || gap >= CHUNK_GAP_S || punct || uttEnds.has(i) || tooLong) {
      boundaries.push(i)
      chunkStart = i + 1
    }
  }
  const chunks: Chunk[] = []
  let s = 0
  for (let c = 0; c < boundaries.length; c++) {
    const e = boundaries[c]
    const ws = words.slice(s, e + 1)
    chunks.push({
      id: `chunk_${String(c + 1).padStart(3, '0')}`,
      wordStart: s,
      wordEnd: e,
      start: ws[0].start,
      end: ws[ws.length - 1].end,
      text: ws.map((w) => w.word).join(' '),
      norm: ws
        .map((w) => normToken(w.word))
        .filter((t) => t && !HESITATIONS.has(t))
        .join(' ')
    })
    s = e + 1
  }
  return chunks
}

// ---- 2. fillers: detect, then CLASSIFY (never blanket-remove) ----
export function detectFillers(words: VerbatimWord[]): FillerDecision[] {
  const out: FillerDecision[] = []
  const norm = words.map((w) => normToken(w.word))
  const used = new Set<number>()
  let id = 0
  const push = (a: number, b: number, cls: FillerClass, reason: string): void => {
    for (let i = a; i <= b; i++) used.add(i)
    out.push({
      id: `filler_${String(++id).padStart(3, '0')}`,
      word_start_index: a,
      word_end_index: b,
      start: words[a].start,
      end: words[b].end,
      text: words.slice(a, b + 1).map((w) => w.word).join(' '),
      classification: cls,
      reason
    })
  }
  const phraseAt = (i: number, phrase: string[]): boolean =>
    phrase.every((tok, k) => norm[i + k] === tok)

  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue
    // retake markers first (longest phrases win)
    const marker = RETAKE_MARKERS.filter((p) => phraseAt(i, p)).sort((a, b) => b.length - a.length)[0]
    if (marker) {
      push(i, i + marker.length - 1, 'retake_marker', 'spoken retake command — remove and treat the preceding attempt as a flub')
      continue
    }
    if (HESITATIONS.has(norm[i])) {
      // absorb a run: "uh um uh"
      let j = i
      while (j + 1 < words.length && HESITATIONS.has(norm[j + 1])) j++
      push(i, j, 'remove', j > i ? 'hesitation cluster' : 'hesitation filler')
      continue
    }
    const phrase = DISCOURSE_PHRASES.filter((p) => phraseAt(i, p)).sort((a, b) => b.length - a.length)[0]
    if (phrase) {
      const j = i + phrase.length - 1
      // ugly only when glued to hesitations: "uh you know um"
      const uglyNeighbor = (i > 0 && HESITATIONS.has(norm[i - 1])) || (j + 1 < norm.length && HESITATIONS.has(norm[j + 1]))
      push(i, j, uglyNeighbor ? 'remove' : 'keep', uglyNeighbor ? 'discourse phrase inside a hesitation cluster' : 'natural conversational phrase')
      continue
    }
    if (DISCOURSE.has(norm[i])) {
      const doubled = norm[i + 1] === norm[i] // "like like"
      const uglyNeighbor = (i > 0 && HESITATIONS.has(norm[i - 1])) || HESITATIONS.has(norm[i + 1] ?? '')
      if (doubled) push(i, i + 1, 'shorten', 'stuttered discourse word — keep one')
      else push(i, i, uglyNeighbor ? 'remove' : 'keep', uglyNeighbor ? 'discourse word glued to hesitation' : 'natural emphasis/discourse word')
    }
  }
  return out
}

// ---- 3. similarity + retake grouping (CHUNKS, never word-by-word) ----
export function similarity(aNorm: string, bNorm: string): number {
  const a = aNorm.split(' ').filter(Boolean)
  const b = bNorm.split(' ').filter(Boolean)
  if (!a.length || !b.length) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let inter = 0
  for (const t of setA) if (setB.has(t)) inter++
  const jaccard = inter / (setA.size + setB.size - inter)
  let prefix = 0
  const minLen = Math.min(a.length, b.length)
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++
  const prefixRatio = prefix >= MIN_PREFIX_TOKENS ? prefix / minLen : 0
  return Math.max(jaccard, prefixRatio)
}

/** Retake similarity between an EARLIER chunk `a` and a LATER chunk `b`.
 *
 *  Sharper than plain text similarity: a true retake means the speaker
 *  ABANDONED `a` and re-said it in `b`. A parallel construction ("You get the
 *  cleansing FOAM / You get the cleansing OIL", "it's gonna help STRENGTHEN /
 *  help RESTORE your skin barrier") shares the same frame but substitutes the
 *  tail — that is content, never a retake. Rules:
 *   - a shared prefix only counts when the earlier attempt essentially STOPPED
 *     there (nothing left over), audibly broke off (AssemblyAI writes a
 *     trailing em dash: "my—", "bundle—"), or its leftover is re-said in b;
 *   - near-equal-length twins whose only difference is disjoint tail content
 *     get their jaccard capped below threshold (the parallel-list veto). */
export interface PairFeatures {
  sim: number
  jaccard: number
  /** shared-opening token count. */
  prefixTokens: number
  prefixOverlap: number // prefixTokens / minLen, unqualified
  restA: string[]
  restB: string[]
  /** earlier chunk audibly broke off (trailing em dash). */
  abandoned: boolean
  /** near-equal twins whose only difference is disjoint tail content. */
  listLike: boolean
  /** exactly one substituted final token on each side ("scent" -> "perfume"). */
  singleTokenSwap: boolean
}

export function pairFeatures(a: Chunk, b: Chunk): PairFeatures {
  const ta = a.norm.split(' ').filter(Boolean)
  const tb = b.norm.split(' ').filter(Boolean)
  const empty: PairFeatures = {
    sim: 0, jaccard: 0, prefixTokens: 0, prefixOverlap: 0, restA: ta, restB: tb,
    abandoned: false, listLike: false, singleTokenSwap: false
  }
  if (!ta.length || !tb.length) return empty
  const setA = new Set(ta)
  const setB = new Set(tb)
  let inter = 0
  for (const t of setA) if (setB.has(t)) inter++
  const jaccard = inter / (setA.size + setB.size - inter)
  let p = 0
  const minLen = Math.min(ta.length, tb.length)
  while (p < minLen && ta[p] === tb[p]) p++
  const restA = ta.slice(p)
  const restB = tb.slice(p)
  const abandoned = DASH_RE.test(a.text.trim())
  const leftoverCovered = restA.every((t) => setB.has(t))
  const prefixQualifies =
    p >= MIN_PREFIX_TOKENS && (restA.length === 0 || abandoned || (restA.length <= 2 && leftoverCovered))
  const prefixRatio = prefixQualifies ? p / minLen : 0
  const disjointTails =
    restA.length > 0 && restB.length > 0 && !restA.some((t) => setB.has(t)) && !restB.some((t) => setA.has(t))
  const listLike = disjointTails && Math.abs(ta.length - tb.length) <= 1 && !abandoned
  const singleTokenSwap = disjointTails && restA.length === 1 && restB.length === 1
  return {
    sim: Math.max(listLike ? Math.min(jaccard, 0.4) : jaccard, prefixRatio),
    jaccard,
    prefixTokens: p,
    prefixOverlap: minLen ? p / minLen : 0,
    restA,
    restB,
    abandoned,
    listLike,
    singleTokenSwap
  }
}

/** Back-compat wrapper (harness + external callers). */
export function retakeSimilarity(a: Chunk, b: Chunk): number {
  return pairFeatures(a, b).sim
}

/** first 3 content-frame tokens (leading connectives stripped) — series probe. */
function frame3(c: Chunk): string {
  const toks = c.norm.split(' ').filter(Boolean)
  let s = 0
  while (s < toks.length && LEADING_CONNECTIVES.has(toks[s])) s++
  return toks.slice(s, s + 3).join(' ')
}

/** ms of air after a chunk (before the next word), for debug + false starts. */
function silenceAfterMs(c: Chunk, words: VerbatimWord[]): number {
  const next = words[c.wordEnd + 1]
  return next ? Math.max(0, Math.round((next.start - words[c.wordEnd].end) * 1000)) : 9999
}

/**
 * tail_fragment_continuation_veto / cross_chunk_completion_veto.
 *
 * TRUE when `chunks[idx]` is not an independent utterance at all — it exists
 * only because CHUNK_MAX_WORDS forced buildChunks to split mid-sentence (the
 * PREVIOUS chunk hit the length cap without ending on real punctuation, and
 * the gap into this chunk is a normal same-breath gap, not a pause). Such a
 * chunk is the grammatical COMPLETION of the previous chunk ("...a 5-step
 * routine to help" | "clear out those pores.") and must never be compared
 * against anything as if it were a standalone retake attempt — an earlier,
 * textually-similar SHORT sentence elsewhere is not what it is a retake of. */
function isTailFragmentContinuation(chunks: Chunk[], idx: number): boolean {
  if (idx <= 0) return false
  const prev = chunks[idx - 1]
  const cur = chunks[idx]
  const prevHitLengthCap = prev.wordEnd - prev.wordStart + 1 >= CHUNK_MAX_WORDS
  const prevEndsSentence = /[.!?]["')\]]?$/.test(prev.text.trim())
  return prevHitLengthCap && !prevEndsSentence && cur.start - prev.end < CHUNK_GAP_S
}

// numbered_progression_veto / parallel_countdown_list_veto — closed class of
// cardinal/ordinal number words. Doubling a NUMBER is content (a countdown or
// numbered list: "not just one, not just two, ... but five"), never a retake.
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10
}

function maskNumbers(tokens: string[]): { masked: string[]; nums: number[] } {
  const masked: string[] = []
  const nums: number[] = []
  for (const t of tokens) {
    if (NUMBER_WORDS[t] !== undefined) {
      masked.push('#')
      nums.push(NUMBER_WORDS[t])
    } else masked.push(t)
  }
  return { masked, nums }
}

/** Smallest block (>=2 tokens, containing the number slot) that `masked`
 *  consists of repeated >=2 times back-to-back, or null. */
function findRepeatingNumberBlock(masked: string[]): { blockLen: number } | null {
  for (let blockLen = 2; blockLen <= Math.floor(masked.length / 2); blockLen++) {
    const block = masked.slice(0, blockLen)
    if (!block.includes('#')) continue
    let count = 0
    let p = 0
    for (; p + blockLen <= masked.length; p += blockLen) {
      if (!block.every((t, x) => masked[p + x] === t)) break
      count++
    }
    if (count >= 2 && p >= masked.length - (blockLen - 1)) return { blockLen }
  }
  return null
}

/** TRUE when the only real difference between two chunk texts is WHICH
 *  distinct number in a progression they name — a countdown/list, not a
 *  failed-and-retried line. Handles both "chunk A itself repeats a <frame> #
 *  template N times and chunk B repeats it once more" (the real case: "you're
 *  not just gonna get one/two/three," then "...four,") and the simpler
 *  two-chunk "step one…" / "step two…" form. */
export function isNumberedProgressionPair(aNorm: string, bNorm: string): boolean {
  const at = aNorm.split(' ').filter(Boolean)
  const bt = bNorm.split(' ').filter(Boolean)
  const am = maskNumbers(at)
  const bm = maskNumbers(bt)
  if (!am.nums.length && !bm.nums.length) return false
  const distinctProgression = (nums: number[]): boolean => nums.length >= 2 && new Set(nums).size === nums.length
  const tryDirection = (repSide: { masked: string[]; nums: number[] }, otherSide: { masked: string[]; nums: number[] }): boolean => {
    const rep = findRepeatingNumberBlock(repSide.masked)
    if (!rep) return false
    const block = repSide.masked.slice(0, rep.blockLen)
    if (otherSide.masked.length !== rep.blockLen) return false
    if (!block.every((t, i) => t === otherSide.masked[i])) return false
    return distinctProgression([...repSide.nums, ...otherSide.nums])
  }
  if (tryDirection(am, bm)) return true
  if (tryDirection(bm, am)) return true
  // simplest case: neither has internal repeats, both are "<frame> #", frames
  // match, numbers differ.
  if (am.masked.length === bm.masked.length && am.nums.length === 1 && bm.nums.length === 1) {
    if (am.masked.every((t, i) => t === bm.masked[i]) && am.nums[0] !== bm.nums[0]) return true
  }
  return false
}

export function findRetakeGroups(
  chunks: Chunk[],
  words: VerbatimWord[],
  fillers: FillerDecision[]
): { groups: RetakeGroup[]; candidates: RepetitionCandidate[]; rejections: RejectedCandidate[] } {
  const candidates: RepetitionCandidate[] = []
  const rejections: RejectedCandidate[] = []
  // union-find over chunk indices (CONFIRMED links only)
  const parent = chunks.map((_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const union = (a: number, b: number): void => {
    parent[find(b)] = find(a)
  }
  const linkType = new Map<number, string>() // chunk index -> how it got linked
  // Provisional pairs: plausible retakes the RULES are not sure about — they
  // become provisional 2-member groups that cut ONLY if the LLM judge affirms.
  const provisionalPairs: { i: number; j: number; f: PairFeatures; type: string }[] = []
  // A spoken retake command ("no wait, let me say that again") marks whatever
  // precedes it as a flub even when similarity alone wouldn't catch it.
  const markerStarts = fillers.filter((f) => f.classification === 'retake_marker').map((f) => f.word_start_index)
  const reject = (i: number, j: number, f: PairFeatures, type: string, reason: string): void => {
    rejections.push({
      a: chunks[i].id,
      b: chunks[j].id,
      candidate_type: type,
      similarity_score: Math.round(f.sim * 100) / 100,
      prefix_overlap_score: Math.round(f.prefixOverlap * 100) / 100,
      has_cutoff_marker: f.abandoned,
      silence_after_ms: silenceAfterMs(chunks[i], words),
      rejection_reason: reason,
      was_sent_to_llm: false,
      llm_decision_if_any: null
    })
  }
  for (let i = 0; i < chunks.length; i++) {
    // tail_fragment_continuation_veto / cross_chunk_completion_veto: this
    // chunk is not an independent utterance — never usable as either side of
    // a retake match.
    if (isTailFragmentContinuation(chunks, i)) continue
    for (let j = i + 1; j <= Math.min(i + RETAKE_MAX_LOOKAHEAD, chunks.length - 1); j++) {
      if (chunks[j].start - chunks[i].end > RETAKE_WINDOW_S) break
      if (isTailFragmentContinuation(chunks, j)) {
        rejections.push({
          a: chunks[i].id,
          b: chunks[j].id,
          candidate_type: 'tail_fragment_continuation_veto',
          similarity_score: -1,
          prefix_overlap_score: -1,
          has_cutoff_marker: false,
          silence_after_ms: silenceAfterMs(chunks[j - 1], words),
          rejection_reason: `cross_chunk_completion_veto: "${chunks[j].text}" completes the previous chunk's unfinished phrase, not a standalone retake attempt`,
          was_sent_to_llm: false,
          llm_decision_if_any: null
        })
        continue
      }
      const f = pairFeatures(chunks[i], chunks[j])
      if (f.sim > 0.3 || (f.prefixTokens >= PREFIX_RETAKE_MIN && f.singleTokenSwap))
        candidates.push({ a: chunks[i].id, b: chunks[j].id, similarity: Math.round(f.sim * 100) / 100 })
      if (isNumberedProgressionPair(chunks[i].norm, chunks[j].norm)) {
        reject(i, j, f, 'numbered_progression_veto', 'parallel_countdown_list_veto: numbers form a genuine ascending/distinct progression — rhetorical buildup, not a retake')
        continue
      }
      const markerLinks =
        j === i + 1 && markerStarts.some((m) => m >= chunks[i].wordStart && m < chunks[j].wordStart)
      // ---- tiered decision ----
      if (f.sim >= SIM_THRESHOLD || markerLinks) {
        union(i, j)
        linkType.set(i, markerLinks && f.sim < SIM_THRESHOLD ? 'marker' : 'similarity')
        continue
      }
      // dash-abandoned earlier chunk: the speaker audibly broke off — a much
      // weaker text match is enough ("…I had to wait a freaking—" -> redo).
      if (f.abandoned && f.sim >= AMBIG_SIM) {
        union(i, j)
        linkType.set(i, 'dash_retake')
        continue
      }
      // parallel-series probe: 3+ nearby chunks sharing the same opening frame
      // ("You get the cleansing FOAM / OIL / and the mud MASK") are enumerated
      // content — never retakes, never worth an LLM call.
      const seriesOf = (): number => {
        const fr = frame3(chunks[i])
        let n = 0
        for (let k = Math.max(0, i - 3); k <= Math.min(chunks.length - 1, j + 3); k++) {
          if (frame3(chunks[k]) === fr) n++
        }
        return n
      }
      // Applies to SUBSTITUTED-content pairs only: a progressive retake is a
      // pure prefix extension (restA empty) or audibly broken off — those are
      // exempt even when 3 takes share the frame.
      const substituted = f.restA.length > 0 && !f.abandoned
      if (substituted && frame3(chunks[i]) === frame3(chunks[j]) && seriesOf() >= 3) {
        reject(i, j, f, f.singleTokenSwap ? 'prefix_swap' : 'substituted_tail', `parallel series of ${seriesOf()} chunks sharing "${frame3(chunks[i])}…" — content, not a retake`)
        continue
      }
      // prefix-swap retake: same long opening, ONE substituted final word
      // ("…my girl this SCENT." -> "…my girl this PERFUME.").
      if (f.singleTokenSwap && f.prefixTokens >= PREFIX_RETAKE_MIN) {
        union(i, j)
        linkType.set(i, 'prefix_swap')
        continue
      }
      // ambiguous: plausible but unproven — LLM judge decides, rules never cut.
      if (f.sim >= AMBIG_SIM && j - i <= 2) {
        provisionalPairs.push({ i, j, f, type: f.listLike ? 'substituted_tail' : 'ambiguous' })
        continue
      }
      if (f.sim > 0.3) reject(i, j, f, 'similarity', `similarity ${f.sim.toFixed(2)} below ambiguity floor ${AMBIG_SIM}`)
    }
  }
  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < chunks.length; i++) {
    const r = find(i)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r)!.push(i)
  }
  const groups: RetakeGroup[] = []
  let gid = 0
  const inConfirmed = new Set<number>()
  const makeGroup = (members: number[], provisional: boolean, type: string): void => {
    members.sort((a, b) => a - b)
    const attempts: RetakeAttempt[] = members.map((ci, k) => {
      const c = chunks[ci]
      return {
        attempt_id: `take_${k + 1}`,
        start: c.start,
        end: c.end,
        text: c.text,
        word_start_index: c.wordStart,
        word_end_index: c.wordEnd,
        complete: false,
        score: 0,
        reasons: []
      }
    })
    scoreAttempts(attempts, words, fillers)
    const keeper = attempts.reduce((best, a) => (a.score >= best.score ? a : best), attempts[0])
    groups.push({
      retake_group_id: `group_${String(++gid).padStart(3, '0')}`,
      attempts,
      keep_attempt: keeper.attempt_id,
      remove_attempts: attempts.filter((a) => a !== keeper).map((a) => a.attempt_id),
      reason: `${keeper.attempt_id} scored highest: ${keeper.reasons.join(', ') || 'most complete attempt'}`,
      candidate_type: type,
      provisional: provisional || undefined,
      chunk_ids: members.map((ci) => chunks[ci].id)
    })
  }
  for (const members of byRoot.values()) {
    if (members.length < 2) continue
    for (const m of members) inConfirmed.add(m)
    makeGroup(members, false, linkType.get(members[0]) ?? 'similarity')
  }
  for (const p of provisionalPairs) {
    if (inConfirmed.has(p.i) || inConfirmed.has(p.j)) continue
    makeGroup([p.i, p.j], true, p.type)
  }
  return { groups, candidates, rejections }
}

// ---- 3b. abandoned false starts (dash tail, no matching redo) ----
// "Okay ladies, if you are a baddie on a budget, I'm gonna need—" [pause]
// "then this is for you…"  ->  cut ONLY "I'm gonna need—" (from the last
// natural phrase boundary), keep the hook.
export function detectFalseStarts(chunks: Chunk[], words: VerbatimWord[], groups: RetakeGroup[]): TailCut[] {
  const grouped = new Set<number>()
  for (const g of groups) {
    if (g.llm_rejected) continue
    for (const a of g.attempts) for (let i = a.word_start_index; i <= a.word_end_index; i++) grouped.add(i)
  }
  const out: TailCut[] = []
  for (const c of chunks) {
    if (!DASH_RE.test(c.text.trim())) continue
    if (grouped.has(c.wordEnd)) continue // a retake group already owns it
    const pause = silenceAfterMs(c, words)
    if (pause < FALSE_START_MIN_PAUSE_MS) continue
    // last natural phrase boundary: punctuation, an intra-chunk pause, or a
    // clause connective starting the tail.
    let boundary = -1
    for (let t = c.wordStart; t < c.wordEnd; t++) {
      const punct = /[,.;:!?]["')\]]?$/.test(words[t].word.trim())
      const gap = words[t + 1].start - words[t].end >= 0.25
      const conj = ['but', 'so', 'then'].includes(normToken(words[t + 1].word))
      if (punct || gap || conj) boundary = t
    }
    let tailStart = boundary >= 0 ? boundary + 1 : c.wordStart
    if (tailStart - c.wordStart < 3) tailStart = c.wordStart // no real setup -> whole chunk
    const tailLen = c.wordEnd - tailStart + 1
    if (tailLen > FALSE_START_MAX_TAIL) continue // too big to cut on a dash alone
    out.push({
      chunk_id: c.id,
      word_start_index: tailStart,
      word_end_index: c.wordEnd,
      text: words.slice(tailStart, c.wordEnd + 1).map((w) => w.word).join(' '),
      reason: `abandoned false start (cut-off "—", ${pause}ms pause after)`,
      silence_after_ms: pause
    })
  }
  return out
}

// Bare openers a speaker abandons and re-starts. Kept TIGHT so genuine parallel
// structure ("I'm happy, I'm sad") is never cut: for the no-dash case the
// fragment must be one of these incomplete openers AND the next chunk must
// re-open with the fragment's EXACT tokens.
const INCOMPLETE_OPENERS = new Set([
  'i', 'you', 'he', 'she', 'we', 'they', 'it', 'this', 'that', 'these', 'those', 'the', 'a', 'an',
  "i'm", "it's", "that's", "there's", "we're", "they're", "you're", "he's", "she's", "i've", "i'll", "we'll"
])
const SHORT_RESTART_MAX_TOKENS = 3

/** 3b2. SHORT abandoned openers re-started in the NEXT chunk — cross-chunk, so
 *  the dash-only false-start detector and the in-chunk self-correction detector
 *  both miss them: "I'm," → "I'm glad I took the risk.", "this is—" → "this is
 *  probably…". Fires on (a) a clear cut-off dash ending the fragment, or (b) a
 *  bare incomplete opener whose EXACT tokens re-open the next chunk. */
export function detectShortRestarts(chunks: Chunk[], words: VerbatimWord[], groups: RetakeGroup[]): TailCut[] {
  const grouped = new Set<number>()
  for (const g of groups) {
    if (g.llm_rejected) continue
    for (const a of g.attempts) for (let i = a.word_start_index; i <= a.word_end_index; i++) grouped.add(i)
  }
  const out: TailCut[] = []
  for (let ci = 0; ci < chunks.length - 1; ci++) {
    const a = chunks[ci]
    const b = chunks[ci + 1]
    if (grouped.has(a.wordStart) || grouped.has(a.wordEnd)) continue
    if (a.wordEnd - a.wordStart + 1 > SHORT_RESTART_MAX_TOKENS) continue
    const aText = a.text.trim()
    if (/[.!?]["')\]]?$/.test(aText)) continue // a completed sentence is not abandoned
    const aTokens: string[] = []
    for (let i = a.wordStart; i <= a.wordEnd; i++) {
      const t = normToken(words[i].word)
      if (t) aTokens.push(t)
    }
    if (!aTokens.length) continue
    const bTokens: string[] = []
    for (let i = b.wordStart; i <= b.wordEnd && bTokens.length < aTokens.length; i++) {
      const t = normToken(words[i].word)
      if (t) bTokens.push(t)
    }
    const dashAbandoned = DASH_RE.test(aText)
    const sameOpening = bTokens.length >= aTokens.length && aTokens.every((t, i) => bTokens[i] === t)
    const bareOpener = INCOMPLETE_OPENERS.has(aTokens[0])
    if (!(dashAbandoned || (sameOpening && bareOpener))) continue
    out.push({
      chunk_id: a.id,
      word_start_index: a.wordStart,
      word_end_index: a.wordEnd,
      text: words.slice(a.wordStart, a.wordEnd + 1).map((w) => w.word).join(' '),
      reason: dashAbandoned
        ? 'abandoned short start (cut-off "—", re-started next line)'
        : 'abandoned short start (same opener re-started next line)',
      kind: 'short_restart'
    })
  }
  return out
}

// ---- 3c. in-chunk self-corrections + lead-in orphans + stutter restarts ----
// "…do not be surprised if you got— or do not be surprised if your mans
// wants…"  ->  cut the abandoned first attempt through the correction marker.
// Also covers (all real creator patterns, 2026-07-08 scalp-brush video):
//  - "your— be very careful…"            leading dashed orphan at chunk start
//  - "And these 30— and these 36…"       corrected word breaks the exact match
//  - "Starting to get— it's starting…"   redo inserts a lead-in token
//  - "It's got PDRN, it's got PDRN and…" immediate repeat WITHOUT a dash
export function detectSelfCorrections(chunks: Chunk[], words: VerbatimWord[]): TailCut[] {
  const out: TailCut[] = []
  const taken = new Set<number>() // word indices already claimed by a cut
  const claim = (a: number, b: number): void => {
    for (let i = a; i <= b; i++) taken.add(i)
  }
  for (const c of chunks) {
    // leading dashed orphan: the first word(s) of the chunk are cut-off debris
    // from an abandoned take ("your— be very careful using this brush…").
    if (DASH_RE.test(words[c.wordStart].word.trim()) && c.wordEnd - c.wordStart >= 3) {
      let e = c.wordStart
      while (e + 1 < c.wordEnd && DASH_RE.test(words[e + 1].word.trim())) e++
      claim(c.wordStart, e)
      out.push({
        chunk_id: c.id,
        word_start_index: c.wordStart,
        word_end_index: e,
        text: words.slice(c.wordStart, e + 1).map((w) => w.word).join(' '),
        reason: 'abandoned lead-in (cut-off "—" at the start of the sentence)',
        kind: 'lead_in_orphan'
      })
    }
    for (let k = c.wordStart; k < c.wordEnd; k++) {
      if (taken.has(k)) continue
      if (!DASH_RE.test(words[k].word.trim())) continue
      // optional spoken correction marker right after the cut-off
      let markerLen = 0
      if (normToken(words[k + 1]?.word ?? '') === 'i' && normToken(words[k + 2]?.word ?? '') === 'mean') markerLen = 2
      else if (CORRECTION_MARKERS.has(normToken(words[k + 1]?.word ?? ''))) markerLen = 1
      const restart = k + 1 + markerLen
      if (restart > c.wordEnd) continue // dash at chunk end -> false-start detector
      // The re-said opening: a 2-6 token run at/near the restart that also
      // occurs earlier in the SAME chunk (that earlier occurrence is the flub).
      // `shift` lets the redo insert one lead-in token ("Starting to get— IT'S
      // starting to get…"); the earlier occurrence may include the dashed word
      // itself ("…to get—" matches "starting to get").
      let cutFrom = -1
      outer: for (let m = 6; m >= 2 && cutFrom < 0; m--) {
        for (let shift = 0; shift <= 1; shift++) {
          if (restart + shift + m - 1 > c.wordEnd) continue
          const seq = words.slice(restart + shift, restart + shift + m).map((w) => normToken(w.word))
          for (let s = k - m + 1; s >= c.wordStart; s--) {
            if (s + m - 1 > k) continue
            if (seq.every((t, x) => normToken(words[s + x].word) === t)) {
              cutFrom = s
              break outer
            }
          }
        }
      }
      if (cutFrom < 0 && markerLen > 0) {
        // no repeated opening, but an explicit marker: cut back to the last
        // phrase boundary before the dash.
        cutFrom = k
        for (let t = k - 1; t >= c.wordStart; t--) {
          if (/[,.;:!?]["')\]]?$/.test(words[t].word.trim()) || words[t + 1].start - words[t].end >= 0.25) {
            cutFrom = t + 1
            break
          }
          cutFrom = t
        }
      }
      if (cutFrom < 0) continue
      if (restart - 1 - cutFrom + 1 > 12) continue // runaway guard
      claim(cutFrom, restart - 1)
      out.push({
        chunk_id: c.id,
        word_start_index: cutFrom,
        word_end_index: restart - 1,
        text: words.slice(cutFrom, restart).map((w) => w.word).join(' '),
        reason: `in-chunk self-correction (cut-off "—"${markerLen ? ' + spoken marker' : ''}, restarted within the sentence)`,
        kind: 'self_correction'
      })
    }
    // partial-word restart: a dashed PARTIAL word whose stem is a prefix of the
    // very next word after a small gap ("…but pre- Pre and probiotics" ->
    // cut only "pre-"). Distinct from a whole-word repeat: the cut-off is an
    // incomplete word finished/restarted by the next token.
    for (let k = c.wordStart; k < c.wordEnd; k++) {
      if (taken.has(k)) continue
      if (!DASH_RE.test(words[k].word.trim())) continue
      const stem = normToken(words[k].word) // normToken drops the trailing dash
      if (stem.length < 2) continue
      const nxt = words[k + 1]
      if (nxt.start - words[k].end > 1.2) continue
      const nn = normToken(nxt.word)
      if (nn.length < stem.length || !nn.startsWith(stem)) continue
      claim(k, k)
      out.push({
        chunk_id: c.id,
        word_start_index: k,
        word_end_index: k,
        text: words[k].word,
        reason: `partial-word restart (started "${words[k].word}", restarted as "${nxt.word}")`,
        kind: 'partial_word_restart'
      })
    }
    // micro cutoff fragment: a short abandoned mini-clause — a leading connective
    // + tiny cut-off word, where the clause immediately RESTARTS with the same
    // connective ("…enzymes and it— and they help break down…" -> cut "and it—").
    // Multiple such fragments can stack inside one chunk.
    for (let k = c.wordStart; k < c.wordEnd; k++) {
      if (taken.has(k)) continue
      if (!DASH_RE.test(words[k].word.trim())) continue
      let s = -1
      for (let t = k - 1; t >= Math.max(c.wordStart, k - 3); t--) {
        if (LEADING_CONNECTIVES.has(normToken(words[t].word))) {
          s = t
          break
        }
      }
      if (s < 0 || k - s + 1 > 4) continue // fragment must be a small mini-clause
      const nxt = words[k + 1]
      if (!nxt || nxt.start - words[k].end > 1.2) continue
      if (normToken(nxt.word) !== normToken(words[s].word)) continue // same connective restart
      claim(s, k)
      out.push({
        chunk_id: c.id,
        word_start_index: s,
        word_end_index: k,
        text: words.slice(s, k + 1).map((w) => w.word).join(' '),
        reason: `micro cutoff fragment (abandoned "${words.slice(s, k + 1).map((w) => w.word).join(' ')}", clause restarted with "${nxt.word}")`,
        kind: 'micro_cutoff_fragment'
      })
    }
  }
  // Stutter restarts WITHOUT a dash: an immediately repeated 1-4 token
  // opening ("It's got PDRN, it's got PDRN and…", "I, I eat somewhat
  // healthy…", "Because, because I thought…") — cut the FIRST occurrence.
  // Checked GLOBALLY (not bounded to one Chunk): the pause that splits words
  // into chunks often lands EXACTLY at the stutter seam itself ("...I," ends
  // one chunk, "I eat..." starts the next), so a same-chunk requirement
  // misses it. What still bounds this to a genuine same-breath restart is the
  // SEAM gap check below — the pause between the two occurrences must stay
  // small, well under a paragraph-level pause.
  // Single-word repeats are a stutter only for CLOSED-CLASS function words
  // (subject pronouns, coordinating/causal conjunctions) — those are almost
  // always disfluency when doubled. A single CONTENT word repeated
  // ("never, never", "so good, so good") is deliberate emphasis and stays;
  // that distinction is the generic rule, not the specific words involved.
  const chunkIdFor = (i: number): string => {
    const ci = chunkIndexForWord(chunks, i)
    return ci >= 0 ? chunks[ci].id : (chunks[chunks.length - 1]?.id ?? '?')
  }
  for (let i = 0; i < words.length; i++) {
    if (taken.has(i)) continue
    for (let m = 4; m >= 1; m--) {
      if (i + 2 * m - 1 >= words.length) continue
      if (m === 1 && !STUTTER_PRONE_SINGLE.has(normToken(words[i].word))) continue
      // A real stutter's FIRST occurrence is an unfinished utterance — if it
      // ends a sentence (".", "!", "?"), this is two independent complete
      // sentences that happen to share a word at the seam ("...literally it.
      // It is that easy."), never a restart.
      if (/[.!?]["')\]]?$/.test(words[i + m - 1].word.trim())) continue
      const seamGap = words[i + m].start - words[i + m - 1].end
      if (seamGap > STUTTER_MAX_GAP_S) continue
      let same = true
      for (let x = 0; x < m; x++) {
        if (normToken(words[i + x].word) !== normToken(words[i + m + x].word)) {
          same = false
          break
        }
      }
      if (!same) continue
      claim(i, i + m - 1)
      out.push({
        chunk_id: chunkIdFor(i),
        word_start_index: i,
        word_end_index: i + m - 1,
        text: words.slice(i, i + m).map((w) => w.word).join(' '),
        reason:
          m === 1
            ? 'repeated connector/pronoun stutter (function word said twice back-to-back)'
            : 'stutter restart (opening said twice back-to-back)',
        kind: 'stutter_restart'
      })
      i += m - 1 // continue after the removed first occurrence
      break
    }
  }
  return out
}

// ---- repeated_setup_retake_detector ----
// "And I came across this study guide, and ever since then, every week at
// church, I came across [study guide.]" then "And ever since then, every
// week at church WHEN THERE'S A DIFFERENT STORY..., I can actually relate to
// it." — the speaker abandons a setup mid-CHUNK (no dash, no punctuation, it
// just trails off) and restarts the SAME opening a beat later, possibly after
// a short leftover fragment the chunker split off on its own. Cut from the
// abandoned restart's connective through the word right before the chunk that
// actually completes the idea; that chunk (the redo) is left untouched.
const REPEATED_SETUP_MAX_TAIL_WORDS = 14
export function detectRepeatedSetups(chunks: Chunk[], words: VerbatimWord[]): TailCut[] {
  const out: TailCut[] = []
  for (let k = 0; k < chunks.length - 1; k++) {
    const c = chunks[k]
    const scanFrom = Math.max(c.wordStart, c.wordEnd - REPEATED_SETUP_MAX_TAIL_WORDS + 1)
    let tailStart = -1
    for (let j = scanFrom; j <= c.wordEnd; j++) {
      if (LEADING_CONNECTIVES.has(normToken(words[j].word))) {
        tailStart = j
        break // the FIRST connective in the tail window starts the abandoned restart
      }
    }
    if (tailStart < 0) continue
    const tailToks = words.slice(tailStart, c.wordEnd + 1).map((w) => normToken(w.word)).filter(Boolean)
    if (tailToks.length < MIN_PREFIX_TOKENS) continue
    for (let r = k + 1; r <= Math.min(k + 2, chunks.length - 1); r++) {
      const redo = chunks[r]
      const redoToks = words.slice(redo.wordStart, redo.wordEnd + 1).map((w) => normToken(w.word)).filter(Boolean)
      let p = 0
      while (p < tailToks.length && p < redoToks.length && tailToks[p] === redoToks[p]) p++
      if (p < PREFIX_RETAKE_MIN) continue
      const cutEnd = redo.wordStart - 1
      if (cutEnd < tailStart) continue
      out.push({
        chunk_id: c.id,
        word_start_index: tailStart,
        word_end_index: cutEnd,
        text: words.slice(tailStart, cutEnd + 1).map((w) => w.word).join(' '),
        reason: `repeated setup — abandoned restart of the same idea, completed later ("${redoToks.slice(0, p).join(' ')}…")`,
        kind: 'repeated_setup_retake'
      })
      break // nearest matching redo only
    }
  }
  return out
}

// ---- orphan_connector_before_restart_detector ----
// "...most Christians feel the same way. And [2.4s pause] But now there's
// truly a better way..." — a lone one-word connective chunk immediately
// before a DIFFERENT connective starting the real sentence. The gap here is
// often a real pause (unlike a same-breath stutter), so no tight seam-gap
// bound applies — only a generous anti-runaway ceiling.
const ORPHAN_CONNECTOR_MAX_GAP_S = 4.0
export function detectOrphanConnectors(chunks: Chunk[], words: VerbatimWord[]): TailCut[] {
  const out: TailCut[] = []
  for (let k = 0; k < chunks.length - 1; k++) {
    const c = chunks[k]
    if (c.wordEnd !== c.wordStart) continue // must be a standalone single-word chunk
    const tok = normToken(words[c.wordStart].word)
    if (!LEADING_CONNECTIVES.has(tok)) continue
    const next = chunks[k + 1]
    const nextTok = normToken(words[next.wordStart].word)
    if (!LEADING_CONNECTIVES.has(nextTok) || nextTok === tok) continue
    if (next.start - c.end > ORPHAN_CONNECTOR_MAX_GAP_S) continue
    out.push({
      chunk_id: c.id,
      word_start_index: c.wordStart,
      word_end_index: c.wordEnd,
      text: words[c.wordStart].word,
      reason: `orphan connector before a stronger restart ("${words[c.wordStart].word}" abandoned, replaced by "${words[next.wordStart].word}")`,
      kind: 'orphan_connector_before_restart'
    })
  }
  return out
}

/** Score attempts IN PLACE. The winner is one whole attempt — no splicing. */
export function scoreAttempts(attempts: RetakeAttempt[], words: VerbatimWord[], fillers: FillerDecision[]): void {
  const tokens = (a: RetakeAttempt): number => a.word_end_index - a.word_start_index + 1
  const maxTokens = Math.max(...attempts.map(tokens))
  attempts.forEach((a, idx) => {
    let score = 50
    const reasons: string[] = []
    const ratio = tokens(a) / maxTokens
    score += Math.round(30 * ratio)
    if (ratio >= 0.99) reasons.push('longest/most complete thought')
    else if (ratio < 0.8) reasons.push('shorter than the best attempt')
    // later attempts are usually the intended one
    score += idx * 3
    if (idx === attempts.length - 1) {
      score += 6
      reasons.push('latest attempt')
    }
    // hesitations inside the attempt
    const inside = fillers.filter(
      (f) => f.classification !== 'keep' && f.word_start_index >= a.word_start_index && f.word_end_index <= a.word_end_index
    )
    const hes = inside.filter((f) => f.classification !== 'retake_marker').length
    score -= hes * 4
    if (hes) reasons.push(`${hes} hesitation(s)`)
    // the speaker DECLARED this attempt a flub — it can basically never win
    if (inside.some((f) => f.classification === 'retake_marker')) {
      score -= 25
      reasons.push('contains spoken retake command')
    }
    // strong ending: sentence punctuation or a real pause after the last word
    const lastWord = words[a.word_end_index]
    const nextWord = words[a.word_end_index + 1]
    const endsPunct = /[.!?]["')\]]?$/.test(lastWord.word.trim())
    const pauseAfter = nextWord ? nextWord.start - lastWord.end : 1
    if (endsPunct) {
      score += 6
      reasons.push('ends on sentence punctuation')
    }
    if (pauseAfter >= 0.5) {
      score += 6
      reasons.push('finished the thought (pause after)')
    } else if (pauseAfter < 0.15 && !endsPunct) {
      score -= 8
      reasons.push('ends abruptly')
    }
    // audio confidence when available
    const confs = words.slice(a.word_start_index, a.word_end_index + 1).map((w) => w.confidence ?? -1).filter((c) => c >= 0)
    if (confs.length) score += Math.round(((confs.reduce((x, y) => x + y, 0) / confs.length) - 0.9) * 30)
    a.complete = ratio >= 0.8 && (endsPunct || pauseAfter >= 0.4)
    if (a.complete) reasons.push('complete sentence')
    else reasons.push('incomplete sentence')
    a.score = Math.max(0, Math.min(100, score))
    a.reasons = reasons
  })
}

// ---- 3d. progressive retakes that span MULTIPLE chunks ----
const RUN_GAP_S = 1.4 // pause marking the boundary of a retried "paragraph"
const MAX_RUN_WORDS = 90 // guard against runaway extension
const EXTEND_SIM_MIN = 0.35 // min overlap between FULLY EXTENDED attempts to accept

function chunkIndexForWord(chunks: Chunk[], wordIdx: number): number {
  for (let i = 0; i < chunks.length; i++) if (wordIdx >= chunks[i].wordStart && wordIdx <= chunks[i].wordEnd) return i
  return -1
}

/**
 * A creator restarting a whole paragraph rarely re-chunks it identically —
 * extra stutters, different comma pauses — so findRetakeGroups only reliably
 * matches the ANCHOR chunk where each attempt begins. This widens each
 * CONFIRMED group's attempts forward through the chunks that follow their
 * anchor: stop at the next attempt's anchor, a paragraph-level pause
 * (>= RUN_GAP_S — clearly bigger than the clause-level CHUNK_GAP_S used to
 * build chunks in the first place), or a length guard. The extension is only
 * COMMITTED if the fully-widened attempts remain substantially similar to
 * each other — this is the same protection the anchor match itself relies on
 * (real text overlap), applied at paragraph scale, so it never annexes
 * unrelated content that merely happens to follow a short anchor match. */
export function extendProgressiveRetakes(
  chunks: Chunk[],
  groups: RetakeGroup[],
  words: VerbatimWord[],
  fillers: FillerDecision[]
): void {
  for (const g of groups) {
    if (g.provisional || g.llm_rejected) continue
    if (g.attempts.length < 2) continue
    const anchors = g.attempts
      .map((a) => ({ attempt: a, ci: chunkIndexForWord(chunks, a.word_start_index) }))
      .filter((x) => x.ci >= 0)
      .sort((a, b) => a.ci - b.ci)
    if (anchors.length < 2) continue
    const spans = anchors.map((anchor, idx) => {
      const startCi = anchor.ci
      const boundaryCi = idx + 1 < anchors.length ? anchors[idx + 1].ci : chunks.length
      let endCi = startCi
      for (let k = startCi + 1; k < boundaryCi; k++) {
        if (chunks[k].start - chunks[k - 1].end >= RUN_GAP_S) break
        if (chunks[k].wordEnd - chunks[startCi].wordStart + 1 > MAX_RUN_WORDS) break
        endCi = k
      }
      return { ci0: startCi, ci1: endCi }
    })
    if (!spans.some((s) => s.ci1 > s.ci0)) continue // nothing actually widened
    const texts = spans.map((s) => chunks.slice(s.ci0, s.ci1 + 1).map((c) => c.norm).join(' '))
    let ok = true
    for (let i = 0; i < texts.length && ok; i++) {
      for (let j = i + 1; j < texts.length && ok; j++) {
        if (similarity(texts[i], texts[j]) < EXTEND_SIM_MIN) ok = false
      }
    }
    if (!ok) continue // the widened passages diverged — leave the short anchors as-is
    g.attempts = anchors.map((a, k) => {
      const ws = chunks[spans[k].ci0].wordStart
      const we = chunks[spans[k].ci1].wordEnd
      return {
        attempt_id: a.attempt.attempt_id,
        start: words[ws].start,
        end: words[we].end,
        text: words.slice(ws, we + 1).map((w) => w.word).join(' '),
        word_start_index: ws,
        word_end_index: we,
        complete: false,
        score: 0,
        reasons: []
      }
    })
    scoreAttempts(g.attempts, words, fillers)
    const keeper = g.attempts.reduce((best, a) => (a.score >= best.score ? a : best), g.attempts[0])
    g.keep_attempt = keeper.attempt_id
    g.remove_attempts = g.attempts.filter((a) => a !== keeper).map((a) => a.attempt_id)
    g.reason = `${keeper.attempt_id} scored highest after widening to the full retried passage: ${keeper.reasons.join(', ') || 'most complete attempt'}`
    g.extended = true
  }
}

// ---- 4. LLM decisions: validated, impossible ids ignored, rules stand ----
export function applyLlmDecisions(
  groups: RetakeGroup[],
  fillers: FillerDecision[],
  decisions: LlmDecisions | null,
  warnings: string[]
): void {
  if (!decisions) return
  for (const d of decisions.retake_group_decisions ?? []) {
    const g = groups.find((x) => x.retake_group_id === d.retake_group_id)
    if (!g) {
      warnings.push(`LLM referenced unknown retake group ${d?.retake_group_id} — ignored`)
      continue
    }
    if (d.not_a_retake === true) {
      // the judge vetoed the group — it produces no cuts.
      g.llm_rejected = true
      g.reason = `LLM rejected: ${String(d.reason || 'not a retake').slice(0, 300)}`
      continue
    }
    const keep = g.attempts.find((a) => a.attempt_id === d.keep_attempt)
    if (!keep) {
      warnings.push(`LLM chose impossible attempt ${d?.keep_attempt} in ${g.retake_group_id} — ignored`)
      continue
    }
    g.keep_attempt = keep.attempt_id
    g.remove_attempts = g.attempts.filter((a) => a.attempt_id !== keep.attempt_id).map((a) => a.attempt_id)
    g.reason = `LLM: ${String(d.reason || 'chosen by reviewer').slice(0, 300)}`
    g.provisional = undefined // an affirmed provisional group is now real
  }
  const valid: FillerClass[] = ['keep', 'remove', 'shorten', 'retake_marker']
  for (const d of decisions.filler_decisions ?? []) {
    const f = fillers.find((x) => x.id === d.filler_id)
    if (!f || !valid.includes(d.decision)) {
      warnings.push(`LLM filler decision invalid (${d?.filler_id}/${d?.decision}) — ignored`)
      continue
    }
    // The LLM may only soften/harden filler calls, never invent spans.
    f.classification = d.decision
    f.reason = `LLM: ${String(d.reason || 'reviewed').slice(0, 300)}`
  }
}

// ---- 5. cut spans: whole attempts + false starts + corrections + fillers ----
export function buildCutSpans(
  vt: VerbatimTranscript,
  groups: RetakeGroup[],
  fillers: FillerDecision[],
  falseStarts: TailCut[] = [],
  selfCorrections: TailCut[] = [],
  repeatedSetups: TailCut[] = [],
  orphanConnectors: TailCut[] = []
): CutSpan[] {
  const words = vt.words
  const spans: CutSpan[] = []
  // word-boundary-safe span for an inclusive word index range
  const spanFor = (a: number, b: number): { start: number; end: number } => {
    const prevEnd = a > 0 ? words[a - 1].end : 0
    const nextStart = b + 1 < words.length ? words[b + 1].start : Infinity
    return {
      start: Math.max(prevEnd, words[a].start - PAD_S),
      end: Math.min(nextStart, words[b].end + PAD_S)
    }
  }
  for (const g of groups) {
    // provisional groups cut ONLY once the LLM affirmed them; vetoed never cut.
    if (g.provisional || g.llm_rejected) continue
    for (const id of g.remove_attempts) {
      const a = g.attempts.find((x) => x.attempt_id === id)!
      const s = spanFor(a.word_start_index, a.word_end_index)
      spans.push({
        ...s,
        type: 'failed_retake',
        source: 'retake_aware_beta',
        reason: `Removed ${id} (whole attempt) from ${g.retake_group_id}; keeping ${g.keep_attempt}`
      })
    }
  }
  for (const t of falseStarts) {
    spans.push({
      ...spanFor(t.word_start_index, t.word_end_index),
      type: 'false_start',
      source: 'retake_aware_beta',
      reason: `${t.reason} ("${t.text}")`
    })
  }
  for (const t of selfCorrections) {
    spans.push({
      ...spanFor(t.word_start_index, t.word_end_index),
      type: 'self_correction',
      source: 'retake_aware_beta',
      reason: `${t.reason} ("${t.text}")`
    })
  }
  for (const t of repeatedSetups) {
    spans.push({
      ...spanFor(t.word_start_index, t.word_end_index),
      type: 'repeated_setup',
      source: 'retake_aware_beta',
      reason: `${t.reason} ("${t.text}")`
    })
  }
  for (const t of orphanConnectors) {
    spans.push({
      ...spanFor(t.word_start_index, t.word_end_index),
      type: 'orphan_connector',
      source: 'retake_aware_beta',
      reason: `${t.reason} ("${t.text}")`
    })
  }
  // fillers inside a removed attempt are already covered; skip them
  const covered = (t: number): boolean => spans.some((s) => t >= s.start && t <= s.end)
  for (const f of fillers) {
    if (f.classification === 'keep') continue
    if (covered((f.start + f.end) / 2)) continue
    let a = f.word_start_index
    const b = f.word_end_index
    if (f.classification === 'shorten' && b > a) a = b // keep the first token, drop the stutter
    const s = spanFor(a, b)
    spans.push({
      ...s,
      type: f.classification === 'retake_marker' ? 'retake_marker' : 'filler',
      source: 'retake_aware_beta',
      reason: `${f.classification}: ${f.reason} ("${f.text}")`
    })
  }
  // merge overlapping/adjacent, drop micro-cuts
  spans.sort((x, y) => x.start - y.start)
  const merged: CutSpan[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.start - last.end <= MERGE_GAP_S) {
      last.end = Math.max(last.end, s.end)
      if (!last.reason.includes(s.reason)) last.reason = `${last.reason} + ${s.reason}`
      if (s.type === 'failed_retake') last.type = 'failed_retake'
    } else {
      merged.push({ ...s })
    }
  }
  return merged.filter((s) => s.end - s.start >= MIN_SPAN_S)
}

// ---- 6. spans -> word ids of an app-format transcript (review flags) ----
export function spansToWordIds(
  spans: CutSpan[],
  transcript: import('../types').Transcript
): string[] {
  const ids: string[] = []
  for (const w of transcript.words) {
    const mid = (w.start + w.end) / 2
    if (spans.some((s) => mid >= s.start && mid <= s.end)) ids.push(w.id)
  }
  return ids
}

/** Dash-terminated ("foo—") words that NO final span removed — surfaced for
 *  debugging so genuinely-missed cutoff fragments are visible, never silent. */
export function findMissedCutoffs(
  chunks: Chunk[],
  words: VerbatimWord[],
  spans: CutSpan[]
): MissedCutoff[] {
  const out: MissedCutoff[] = []
  const chunkOf = (i: number): string => chunks.find((c) => i >= c.wordStart && i <= c.wordEnd)?.id ?? '?'
  for (let i = 0; i < words.length; i++) {
    if (!DASH_RE.test(words[i].word.trim())) continue
    const mid = (words[i].start + words[i].end) / 2
    if (spans.some((s) => mid >= s.start && mid <= s.end)) continue
    const gapMs = words[i + 1] ? Math.round((words[i + 1].start - words[i].end) * 1000) : 9999
    out.push({
      chunk_id: chunkOf(i),
      word_index: i,
      word: words[i].word,
      gap_after_ms: gapMs,
      reason:
        gapMs > 1200
          ? 'cut-off followed by a long pause but no matching restart — likely intentional trailing dash'
          : 'cut-off with no detected retake/restart/partial-word match'
    })
  }
  return out
}
