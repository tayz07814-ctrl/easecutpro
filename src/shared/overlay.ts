// Pure helpers for AI-controlled overlay placement. No Node / DOM deps so these
// can be unit-tested headlessly and reused by both the main process and the
// renderer. The LLM call lives in src/main/overlay-rules.ts; everything here is
// deterministic.

import type {
  OverlayAnimation,
  OverlayAsset,
  OverlayEvent,
  OverlayGenResult,
  OverlayPosition,
  OverlayRule,
  OverlaySuggestion,
  Transcript
} from './types'

export interface Sentence {
  index: number
  text: string
  start: number
  end: number
}

export interface CleanOpts {
  /** source media duration (seconds) — clamp target. */
  duration: number
  /** cut-out ranges (deleted/silence) to keep overlays out of. */
  cuts: { start: number; end: number }[]
  maxEvents?: number
  maxPerOverlay?: number
  minDur?: number
  maxDur?: number
  minGap?: number
}

const DEFAULTS = { maxEvents: 30, maxPerOverlay: 3, minDur: 2.5, maxDur: 4, minGap: 0.3 }

/** Map a named position to a normalized box on the frame (x,y = top-left fraction). */
export function positionToBox(position: OverlayPosition): { x: number; y: number; scale: number } {
  switch (position) {
    case 'top_center': return { x: 0.29, y: 0.06, scale: 0.42 }
    case 'center': return { x: 0.29, y: 0.40, scale: 0.42 }
    case 'bottom_center': return { x: 0.29, y: 0.78, scale: 0.42 }
    case 'top_left': return { x: 0.05, y: 0.06, scale: 0.40 }
    case 'top_right': return { x: 0.55, y: 0.06, scale: 0.40 }
    case 'bottom_left': return { x: 0.05, y: 0.78, scale: 0.40 }
    case 'bottom_right': return { x: 0.55, y: 0.78, scale: 0.40 }
    default: return { x: 0.29, y: 0.06, scale: 0.42 }
  }
}

/** Break the transcript into timestamped sentences from its segments (skips cut words). */
export function chunkTranscript(transcript: Transcript): Sentence[] {
  const out: Sentence[] = []
  const segs = transcript.segments ?? []
  for (let i = 0; i < segs.length; i++) {
    const live = segs[i].words.filter((w) => !w.deleted)
    if (live.length === 0) continue
    const text = live.map((w) => w.text).join(' ').trim()
    if (!text) continue
    out.push({ index: out.length, text, start: live[0].start, end: live[live.length - 1].end })
  }
  return out
}

const STOPWORDS = new Set([
  'show', 'this', 'that', 'when', 'i', 'me', 'my', 'the', 'a', 'an', 'or', 'and', 'of', 'to',
  'about', 'talk', 'talking', 'mention', 'mentions', 'mentioning', 'say', 'saying', 'said',
  'feel', 'feeling', 'feels', 'overlay', 'card', 'whenever', 'while', 'during', 'is', 'it',
  'for', 'on', 'in', 'with', 'not', 'no', 'are', 'be', 'being', 'them', 'they', 'we', 'you'
])

/** Pull candidate trigger keywords/phrases out of a free-text instruction. */
export function extractKeywords(instruction: string): string[] {
  const lower = (instruction || '').toLowerCase()
  const out = new Set<string>()
  // multiword phrases between commas / "or" lists are strong signals
  for (const phrase of lower.split(/,|\bor\b|\band\b|;|\./)) {
    const p = phrase.replace(/[^a-z0-9%\s]/g, ' ').trim()
    const words = p.split(/\s+/).filter((w) => w && (w.length >= 3 || /\d/.test(w)) && !STOPWORDS.has(w))
    if (words.length >= 2) out.add(words.slice(0, 4).join(' ')) // keep a short phrase
    for (const w of words) out.add(w)                            // and the individual words
  }
  return [...out].filter(Boolean)
}

function midInCuts(start: number, end: number, cuts: { start: number; end: number }[]): boolean {
  const mid = (start + end) / 2
  return cuts.some((c) => mid >= c.start && mid < c.end)
}

/** No-LLM fallback: place an overlay on sentences whose text contains a rule keyword. */
export function keywordFallback(rules: OverlayRule[], sentences: Sentence[]): OverlayEvent[] {
  const events: OverlayEvent[] = []
  for (const rule of rules) {
    const keys = extractKeywords(rule.instruction)
    if (keys.length === 0) continue
    for (const s of sentences) {
      // Normalize punctuation to spaces so padded lookup is a true WORD match —
      // a bare substring fallback made "art" hit "start" and "tea" hit "instead".
      const hay = ' ' + s.text.toLowerCase().replace(/[^a-z0-9%]+/g, ' ') + ' '
      const hit = keys.find((k) => hay.includes(' ' + k + ' '))
      if (hit) {
        events.push({
          overlayId: rule.overlayId,
          start: s.start,
          end: s.end,
          position: rule.position,
          animation: rule.animation,
          reason: `keyword "${hit}" in: ${s.text.slice(0, 60)}`,
          source: 'keyword'
        })
      }
    }
  }
  return events
}

/**
 * Validate + clean raw events (from LLM or fallback) into safe, non-overlapping
 * placements. position/animation/duration come from the RULE (authoritative);
 * the matcher only chooses WHERE in time. Returns kept events + rejection notes.
 */
export function validateAndCleanEvents(
  raw: Array<Partial<OverlayEvent>>,
  rules: OverlayRule[],
  opts: CleanOpts
): { events: OverlayEvent[]; rejected: string[] } {
  const o = { ...DEFAULTS, ...opts }
  const rulesById = new Map(rules.map((r) => [r.overlayId, r]))
  const rejected: string[] = []

  // 1) normalize each candidate against its rule + the video bounds.
  const normalized: OverlayEvent[] = []
  for (const e of raw) {
    const rule = rulesById.get(String(e.overlayId))
    if (!rule) { rejected.push(`unknown overlayId ${e.overlayId}`); continue }
    let start = Number(e.start)
    if (!Number.isFinite(start)) { rejected.push(`bad start for ${rule.name}`); continue }
    const dur = Math.min(o.maxDur, Math.max(o.minDur, rule.durationSeconds || 3))
    start = Math.max(0, Math.min(start, Math.max(0, o.duration - dur)))
    const end = Math.min(o.duration, start + dur)
    if (end - start < 0.5) { rejected.push(`zero-length for ${rule.name}`); continue }
    if (midInCuts(start, end, o.cuts)) { rejected.push(`${rule.name} lands in a cut-out section`); continue }
    normalized.push({
      overlayId: rule.overlayId,
      start, end,
      position: rule.position,
      animation: rule.animation,
      reason: String(e.reason ?? '').slice(0, 160),
      source: e.source === 'keyword' ? 'keyword' : 'llm',
      confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : undefined
    })
  }

  // 2) sort, then apply each rule's OCCURRENCE deterministically ("only the first
  //    time, not the second"). Selection happens here — on validated, time-ordered
  //    candidates — never in the matcher: LLMs are unreliable at counting, so they
  //    find every mention and this picks. Runs before the overlap/cap pass so a
  //    kept 'first' can't be starved out by an earlier overlay's placement.
  normalized.sort((a, b) => a.start - b.start)
  let selected: OverlayEvent[] = normalized
  if (rules.some((r) => r.occurrence === 'first' || r.occurrence === 'last')) {
    const byOverlay = new Map<string, OverlayEvent[]>()
    for (const e of normalized) {
      const arr = byOverlay.get(e.overlayId) ?? []
      arr.push(e)
      byOverlay.set(e.overlayId, arr)
    }
    selected = []
    for (const [id, arr] of byOverlay) {
      const occ = rulesById.get(id)?.occurrence ?? 'every'
      if (occ === 'every' || arr.length <= 1) selected.push(...arr)
      else {
        selected.push(occ === 'first' ? arr[0] : arr[arr.length - 1])
        rejected.push(`${id}: kept ${occ} of ${arr.length} mention(s)`)
      }
    }
    selected.sort((a, b) => a.start - b.start)
  }

  // 3) greedily drop time-overlaps + enforce per-overlay and global caps.
  const perOverlay = new Map<string, number>()
  const kept: OverlayEvent[] = []
  let lastEnd = -Infinity
  for (const e of selected) {
    if (kept.length >= o.maxEvents) { rejected.push('hit max overlay events'); break }
    if (e.start < lastEnd + o.minGap) { rejected.push(`${e.overlayId} overlaps a kept overlay`); continue }
    const n = perOverlay.get(e.overlayId) ?? 0
    if (n >= o.maxPerOverlay) { rejected.push(`${e.overlayId} over per-overlay cap`); continue }
    kept.push(e)
    perOverlay.set(e.overlayId, n + 1)
    lastEnd = e.end
  }
  return { events: kept, rejected }
}

/** A rule participates with just a NAMED image — no instruction required. An
 *  empty instruction becomes "talk about <name>", so a creator who uploads
 *  Bloating / CTA / Hairfall cards and clicks Generate gets suggestions. Pure,
 *  so both the desktop matcher and the cloud (browser) matcher share it. */
export function deriveInstructions(rules: OverlayRule[], assets: OverlayAsset[]): OverlayRule[] {
  const nameById = new Map(assets.map((a) => [a.id, a.name]))
  const out: OverlayRule[] = []
  for (const r of rules) {
    if (r.instruction.trim()) { out.push(r); continue }
    const topic = (r.name || nameById.get(r.overlayId) || '').trim()
    if (!topic) continue
    out.push({ ...r, instruction: `Show this when I talk about ${topic}.` })
  }
  return out
}

/**
 * Browser-safe, keyword-only overlay placement (no LLM, no Node deps) — the cloud
 * build's matcher and the offline fallback. Mirrors the keyword path of
 * generateOverlayTimeline (src/main/overlay-rules.ts) so cloud and desktop place
 * identically when neither has an API key. Occurrence selection runs inside
 * validateAndCleanEvents, deterministically.
 */
export function keywordOverlayTimeline(
  transcript: Transcript,
  assets: OverlayAsset[],
  rules: OverlayRule[],
  opts: CleanOpts
): OverlayGenResult {
  const log: string[] = []
  const sentences = chunkTranscript(transcript)
  const assetIds = new Set(assets.map((a) => a.id))
  const activeRules = deriveInstructions(rules.filter((r) => assetIds.has(r.overlayId)), assets)
  log.push(`overlay rules received: ${rules.length} (active: ${activeRules.length})`)
  log.push(`transcript chunks processed: ${sentences.length}`)
  if (activeRules.length === 0 || sentences.length === 0) {
    return { events: [], via: 'none', log }
  }
  const raw = keywordFallback(activeRules, sentences)
  const cleaned = validateAndCleanEvents(raw, activeRules, opts)
  log.push(`keyword match: ${raw.length} candidate(s), kept ${cleaned.events.length}`)
  for (const r of cleaned.rejected.slice(0, 25)) log.push(`  rejected: ${r}`)
  return { events: cleaned.events, via: cleaned.events.length ? 'keyword' : 'none', log }
}

// ---- Semantic (LLM) matching: prompt + response parsing, shared by the desktop
//      matcher (src/main/overlay-rules.ts) and the cloud edge-function path. The
//      LLM only proposes sentence indices + confidence; time mapping, occurrence
//      selection and validation all stay deterministic in code. ----

/** Below this confidence an LLM match is dropped (logged, not placed). */
export const MIN_OVERLAY_CONFIDENCE = 0.35

/** System prompt for the overlay matcher. MIRRORED in
 *  supabase/functions/overlay-match/index.ts (Deno can't import this) — keep in sync. */
export const OVERLAY_MATCH_SYSTEM = `You place product-overlay image cards onto a talking-head video by matching each card's RULE to the transcript sentences where that topic is actually discussed.

You receive numbered SENTENCES (with an index) and a list of overlay RULES (each with an overlayId, a name, and a natural-language instruction describing when to show it). Return the sentences where each rule clearly applies.

RULES (precision over recall):
- Match a rule to a sentence ONLY when the sentence clearly discusses what the instruction describes. Judge by MEANING (paraphrases count), not just keywords. When unsure, do NOT match.
- Some rules carry only a NAME (e.g. "No Bloating", "Hairfall", "CTA") — treat the name as the topic and match sentences that discuss it.
- A rule may include "shows: …" describing what the overlay image visually DEPICTS (its text/product/subject). Judge fit by that content too — a card that shows "50% OFF" fits a sentence about a sale even if its name doesn't say so.
- Names that read as a call to action (CTA, subscribe, link, discount, buy) usually belong on the closing lines where the speaker asks the viewer to act — prefer those.
- Return EVERY clearly-matching sentence for a rule, in order — the app itself decides which occurrences to keep (first/last/all). Do not do that selection.
- Return the SENTENCE INDEX, never a timestamp.
- Do not match a rule to a sentence that only mentions the topic in passing or negatively.
- Give each match a confidence from 0 to 1 (1 = the sentence is unmistakably about the topic).

OUTPUT: return ONLY a JSON object, no prose:
{"events":[{"overlayId":"<id>","sentenceIndex":<int>,"confidence":<0..1>,"reason":"<short quote/why>"}]}
If nothing matches, return {"events":[]}.`

/** An overlay's identity as the matchers/suggester see it: name, optional free-text
 *  instruction, and the optional vision `description` of what the image DEPICTS. */
export interface OverlayRuleView { overlayId: string; name: string; instruction: string; description?: string }
export interface OverlayLibView { overlayId: string; name: string; description?: string }

/** Format the SENTENCES + RULES payload the matcher reasons over. */
export function buildOverlayUserMessage(
  sentences: { index: number; text: string }[],
  rules: OverlayRuleView[]
): string {
  const s = sentences.map((x) => `[${x.index}] ${x.text}`).join('\n')
  const r = rules
    .map((x) => `- overlayId=${x.overlayId} | "${x.name}"${x.description ? ` | shows: ${x.description}` : ''} | ${x.instruction}`)
    .join('\n')
  return `SENTENCES:\n${s}\n\nOVERLAY RULES:\n${r}\n\nReturn JSON only.`
}

/** First balanced {…} JSON object in a string, or null. */
export function extractFirstJsonObject(text: string): any | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)) } catch { return null }
    }
  }
  return null
}

/**
 * Parse an overlay matcher's raw JSON reply into sentence-anchored partial events.
 * Drops hallucinated indices and below-threshold confidences (returned separately
 * for logging). Maps the returned SENTENCE INDEX to that sentence's real time —
 * the model never emits timestamps, so it can't invent one.
 */
export function parseOverlayLlmResponse(
  rawText: string,
  sentences: Sentence[]
): { events: Array<Partial<OverlayEvent>>; lowConfidence: string[] } {
  const parsed = extractFirstJsonObject(rawText || '')
  const events: Array<Partial<OverlayEvent>> = []
  const lowConfidence: string[] = []
  for (const e of parsed?.events ?? []) {
    const idx = Number(e?.sentenceIndex)
    if (!Number.isInteger(idx) || idx < 0 || idx >= sentences.length) continue // no hallucinated times
    const confidence = typeof e?.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 1
    if (confidence < MIN_OVERLAY_CONFIDENCE) {
      lowConfidence.push(`${e?.overlayId} @ sentence ${idx} (${confidence.toFixed(2)})`)
      continue
    }
    events.push({
      overlayId: String(e?.overlayId ?? ''),
      start: sentences[idx].start,
      end: sentences[idx].end,
      reason: String(e?.reason ?? ''),
      source: 'llm',
      confidence
    })
  }
  return { events, lowConfidence }
}

// ---- "Suggest": proactive, whole-transcript placement PROPOSALS. Unlike the
//      matcher (which places rules the creator wrote), Suggest reads the entire
//      transcript + the overlay library and proposes overlay↔moment pairs for the
//      creator to review. Shared by the desktop suggester and the cloud edge fn. ----

/** Minimum confidence for a suggestion to survive into the review list. */
export const MIN_SUGGEST_CONFIDENCE = 0.45

/** System prompt for the Suggest engine. MIRRORED in
 *  supabase/functions/overlay-suggest/index.ts (Deno can't import this) — keep in sync. */
export const OVERLAY_SUGGEST_SYSTEM = `You are a video editor's overlay assistant. You read a full talking-head transcript and a LIBRARY of the creator's own overlay image cards, and you PROPOSE where each card should appear — like a creative director planning B-roll.

You receive numbered SENTENCES (the whole video, in order) and an OVERLAY LIBRARY (each item has an overlayId and a name). Propose placements.

HOW TO THINK:
1. Read the whole video as a story and find its BEATS — the hook, the problem, the product/point, proof or examples, and the call-to-action at the end.
2. Find the OVERLAY-WORTHY moments: a specific claim, a number/price, a product or feature mention, an emotional peak, or the CTA. Not every sentence deserves an overlay.
3. For each such moment, pick the library card whose NAME best fits it (judge by meaning; a card named "No Bloating" fits a sentence about a flatter stomach). A library item may include "shows: …" describing what the card visually depicts — match on that content too, not just the name. A call-to-action card (CTA, subscribe, link, discount) belongs on the closing lines.

RULES:
- Only propose a card when it genuinely fits the moment. Precision over recall — a few great placements beat many weak ones.
- Space them out across the video; do not stack overlays or crowd one section.
- Return the SENTENCE INDEX of the moment, never a timestamp.
- Choose a POSITION that won't cover the speaker's face: prefer top_center or bottom_center (use a corner only when it clearly fits).
- Give each proposal a confidence 0..1 and a short reason a creator would understand ("you introduce the discount here").
- Do NOT propose a card for a sentence that only mentions the topic in passing or negatively.

OUTPUT: return ONLY a JSON object, no prose:
{"suggestions":[{"overlayId":"<id>","sentenceIndex":<int>,"position":"top_center|bottom_center|center|top_left|top_right|bottom_left|bottom_right","confidence":<0..1>,"reason":"<why here>"}]}
If nothing is worth an overlay, return {"suggestions":[]}.`

/** Format the SENTENCES + LIBRARY payload the Suggest engine reasons over. */
export function buildSuggestUserMessage(
  sentences: { index: number; text: string }[],
  library: OverlayLibView[]
): string {
  const s = sentences.map((x) => `[${x.index}] ${x.text}`).join('\n')
  const l = library
    .map((x) => `- overlayId=${x.overlayId} | "${x.name}"${x.description ? ` | shows: ${x.description}` : ''}`)
    .join('\n')
  return `SENTENCES:\n${s}\n\nOVERLAY LIBRARY:\n${l}\n\nReturn JSON only.`
}

const POSITIONS = new Set<OverlayPosition>([
  'top_center', 'center', 'bottom_center', 'top_left', 'top_right', 'bottom_left', 'bottom_right'
])

/**
 * Parse a Suggest reply into reviewable suggestions: map sentenceIndex -> real
 * time, drop hallucinated indices / low confidence / cut-section landings, then
 * pace (min gap) and cap. Deterministic — the model only proposes; this makes it
 * safe. `uid` supplies review-list ids (kept out so this stays pure/testable).
 */
export function parseOverlaySuggestions(
  rawText: string,
  sentences: Sentence[],
  assets: OverlayAsset[],
  opts: CleanOpts,
  uid: () => string
): { suggestions: OverlaySuggestion[]; log: string[] } {
  const o = { ...DEFAULTS, maxEvents: 12, ...opts }
  const assetIds = new Set(assets.map((a) => a.id))
  const parsed = extractFirstJsonObject(rawText || '')
  const log: string[] = []
  const raw: Array<OverlaySuggestion & { _conf: number }> = []
  for (const e of parsed?.suggestions ?? []) {
    const overlayId = String(e?.overlayId ?? '')
    if (!assetIds.has(overlayId)) { log.push(`dropped: unknown overlay ${overlayId}`); continue }
    const idx = Number(e?.sentenceIndex)
    if (!Number.isInteger(idx) || idx < 0 || idx >= sentences.length) continue // no hallucinated times
    const confidence = typeof e?.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 0.6
    if (confidence < MIN_SUGGEST_CONFIDENCE) { log.push(`dropped low confidence @ sentence ${idx} (${confidence.toFixed(2)})`); continue }
    const dur = Math.min(o.maxDur, Math.max(o.minDur, 3))
    const start = Math.max(0, Math.min(sentences[idx].start, Math.max(0, o.duration - dur)))
    const end = Math.min(o.duration, start + dur)
    if (end - start < 0.5) continue
    if (midInCuts(start, end, o.cuts)) { log.push(`dropped: moment at ${sentences[idx].start.toFixed(1)}s is cut`); continue }
    const position = POSITIONS.has(e?.position) ? (e.position as OverlayPosition) : 'top_center'
    raw.push({
      id: '', kind: 'overlay', overlayId, start, end, position, animation: 'pop',
      reason: String(e?.reason ?? '').slice(0, 160), sentence: sentences[idx].text.slice(0, 200),
      confidence, _conf: confidence
    })
  }
  // pace + cap: sort by time, drop ones that crowd a kept suggestion, cap total.
  raw.sort((a, b) => a.start - b.start)
  const suggestions: OverlaySuggestion[] = []
  let lastEnd = -Infinity
  for (const s of raw) {
    if (suggestions.length >= o.maxEvents) { log.push('hit suggestion cap'); break }
    if (s.start < lastEnd + o.minGap) { log.push(`dropped: too close to a kept suggestion (${s.start.toFixed(1)}s)`); continue }
    suggestions.push({ id: uid(), kind: 'overlay', overlayId: s.overlayId, start: s.start, end: s.end, position: s.position, animation: s.animation, reason: s.reason, sentence: s.sentence, confidence: s.confidence })
    lastEnd = s.end
  }
  return { suggestions, log }
}

// ---- Moment vision: "point-and-show" detection. When the creator points at
//      something ("this is not acne" over an armpit, then legs, then chest) the
//      transcript is identical — the differentiator is the FRAME. We flag the
//      moments worth LOOKING at, cheaply and with no vision, so the app only
//      samples a handful of frames. ----

// Strong pointing/showing signals only. "that/those/there" are deliberately
// excluded — they're common non-deictic filler ("that is the whole story") and
// caused false positives.
const DEICTIC = /\b(this|these|here|look|watch|notice|showing|show\s+you|check\s+(it|this|these)\s+out|you\s+can\s+see|right\s+here|over\s+here|see\s+this)\b/i

function normalizeLine(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Sentences where the creator is likely SHOWING something on camera — worth a
 * frame-look. Two cheap signals: (1) deictic/pointing language ("this", "here",
 * "look", "you can see"); (2) near-identical repeated lines (the classic
 * "this is not acne" × 3 — same words, different visual each time). Capped to
 * bound how many frames get sent to vision.
 */
export function findShowMoments(sentences: Sentence[], max = 8): Sentence[] {
  const counts = new Map<string, number>()
  for (const s of sentences) {
    const n = normalizeLine(s.text)
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  const picked = new Map<number, Sentence>()
  for (const s of sentences) {
    const repeated = (counts.get(normalizeLine(s.text)) ?? 0) >= 2
    if (repeated || DEICTIC.test(s.text)) picked.set(s.index, s)
  }
  return [...picked.values()].sort((a, b) => a.start - b.start).slice(0, max)
}
