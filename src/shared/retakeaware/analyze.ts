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
  CutSpan,
  LlmDecisions
} from './types'

// ---- tuning ----
const CHUNK_GAP_S = 0.55 // a pause this long ends a sentence-ish chunk
const CHUNK_MAX_WORDS = 26 // fallback split for run-on speech
const RETAKE_WINDOW_S = 25 // compare chunks whose gap is at most this
const RETAKE_MAX_LOOKAHEAD = 4 // ... and at most this many chunks apart
const SIM_THRESHOLD = 0.55 // similarity for "same line, retried"
const MIN_PREFIX_TOKENS = 2 // retakes share how they START
const PAD_S = 0.04 // safe padding around cut spans
const MERGE_GAP_S = 0.12 // spans closer than this merge
const MIN_SPAN_S = 0.12 // never emit micro-cuts

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

export function findRetakeGroups(
  chunks: Chunk[],
  words: VerbatimWord[],
  fillers: FillerDecision[]
): { groups: RetakeGroup[]; candidates: RepetitionCandidate[] } {
  const candidates: RepetitionCandidate[] = []
  // union-find over chunk indices
  const parent = chunks.map((_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const union = (a: number, b: number): void => {
    parent[find(b)] = find(a)
  }
  // A spoken retake command ("no wait, let me say that again") marks whatever
  // precedes it as a flub even when similarity alone wouldn't catch it — link
  // the chunk carrying/preceding the marker to the NEXT content chunk. The
  // speaker explicitly declared a retake; the texts may legitimately differ.
  const markerStarts = fillers.filter((f) => f.classification === 'retake_marker').map((f) => f.word_start_index)
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i + 1; j <= Math.min(i + RETAKE_MAX_LOOKAHEAD, chunks.length - 1); j++) {
      if (chunks[j].start - chunks[i].end > RETAKE_WINDOW_S) break
      const sim = similarity(chunks[i].norm, chunks[j].norm)
      if (sim > 0.3) candidates.push({ a: chunks[i].id, b: chunks[j].id, similarity: Math.round(sim * 100) / 100 })
      const markerLinks =
        j === i + 1 && markerStarts.some((m) => m >= chunks[i].wordStart && m < chunks[j].wordStart)
      if (sim >= SIM_THRESHOLD || markerLinks) union(i, j)
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
  for (const members of byRoot.values()) {
    if (members.length < 2) continue
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
      reason: `${keeper.attempt_id} scored highest: ${keeper.reasons.join(', ') || 'most complete attempt'}`
    })
  }
  return { groups, candidates }
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
    const keep = g.attempts.find((a) => a.attempt_id === d.keep_attempt)
    if (!keep) {
      warnings.push(`LLM chose impossible attempt ${d?.keep_attempt} in ${g.retake_group_id} — ignored`)
      continue
    }
    g.keep_attempt = keep.attempt_id
    g.remove_attempts = g.attempts.filter((a) => a.attempt_id !== keep.attempt_id).map((a) => a.attempt_id)
    g.reason = `LLM: ${String(d.reason || 'chosen by reviewer').slice(0, 300)}`
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

// ---- 5. cut spans: whole attempts + ugly fillers, padded + merged ----
export function buildCutSpans(
  vt: VerbatimTranscript,
  groups: RetakeGroup[],
  fillers: FillerDecision[]
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
