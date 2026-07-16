// AI rule interpretation for overlay placement. The AI ONLY produces structured
// timeline data (overlay events) — it never edits the video. Provider logic is
// isolated here (reuses the existing Claude client); the renderer/store apply the
// data. Falls back to deterministic keyword matching when no LLM key is present
// or the call fails, so generation is reliable and never blocks a render.

import { getAnthropic, claudeAvailable } from './claude'
import { chunkTranscript, keywordFallback, validateAndCleanEvents, deriveInstructions } from '../shared/overlay'
import type { CleanOpts } from '../shared/overlay'
import type {
  OverlayAsset, OverlayEvent, OverlayGenResult, OverlayRule, Transcript
} from '../shared/types'

type ProgressFn = (pct: number, msg?: string) => void

const MODEL = 'claude-opus-4-8'

const SYSTEM_PROMPT = `You place product-overlay image cards onto a talking-head video by matching each card's RULE to the transcript sentences where that topic is actually discussed.

You receive numbered SENTENCES (with an index) and a list of overlay RULES (each with an overlayId, a name, and a natural-language instruction describing when to show it). Return the sentences where each rule clearly applies.

RULES (precision over recall):
- Match a rule to a sentence ONLY when the sentence clearly discusses what the instruction describes. Judge by MEANING (paraphrases count), not just keywords. When unsure, do NOT match.
- Some rules carry only a NAME (e.g. "No Bloating", "Hairfall", "CTA") — treat the name as the topic and match sentences that discuss it.
- Names that read as a call to action (CTA, subscribe, link, discount, buy) usually belong on the closing lines where the speaker asks the viewer to act — prefer those.
- Return EVERY clearly-matching sentence for a rule, in order — the app itself decides which occurrences to keep (first/last/all). Do not do that selection.
- Return the SENTENCE INDEX, never a timestamp.
- Do not match a rule to a sentence that only mentions the topic in passing or negatively.
- Give each match a confidence from 0 to 1 (1 = the sentence is unmistakably about the topic).

OUTPUT: return ONLY a JSON object, no prose:
{"events":[{"overlayId":"<id>","sentenceIndex":<int>,"confidence":<0..1>,"reason":"<short quote/why>"}]}
If nothing matches, return {"events":[]}.`

/** Below this confidence an LLM match is dropped (logged, not placed). */
const MIN_CONFIDENCE = 0.35

function buildUserMessage(
  sentences: { index: number; text: string }[],
  rules: OverlayRule[]
): string {
  const s = sentences.map((x) => `[${x.index}] ${x.text}`).join('\n')
  const r = rules.map((x) => `- overlayId=${x.overlayId} | "${x.name}" | ${x.instruction}`).join('\n')
  return `SENTENCES:\n${s}\n\nOVERLAY RULES:\n${r}\n\nReturn JSON only.`
}

/** First balanced {…} JSON object in a string, or null. */
function extractJson(text: string): any | null {
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

/** Provider-isolated LLM call: sentences + rules -> raw events (sentence-anchored). */
async function callLLMForOverlayRules(
  sentences: { index: number; text: string; start: number; end: number }[],
  rules: OverlayRule[]
): Promise<{ events: Array<Partial<OverlayEvent>>; lowConfidence: string[] }> {
  const client = getAnthropic()
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(sentences, rules) }]
  })
  const block = res.content.find((b) => b.type === 'text')
  const parsed = extractJson(block && block.type === 'text' ? block.text : '')
  const out: Array<Partial<OverlayEvent>> = []
  const lowConfidence: string[] = []
  for (const e of parsed?.events ?? []) {
    const idx = Number(e?.sentenceIndex)
    if (!Number.isInteger(idx) || idx < 0 || idx >= sentences.length) continue // no hallucinated times
    const confidence = typeof e?.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 1
    if (confidence < MIN_CONFIDENCE) {
      lowConfidence.push(`${e?.overlayId} @ sentence ${idx} (${confidence.toFixed(2)})`)
      continue
    }
    out.push({
      overlayId: String(e?.overlayId ?? ''),
      start: sentences[idx].start,
      end: sentences[idx].end,
      reason: String(e?.reason ?? ''),
      source: 'llm',
      confidence
    })
  }
  return { events: out, lowConfidence }
}

/**
 * Turn overlay assets + rules + a transcript into validated overlay events.
 * The LLM (semantic matcher) is PREFERRED when a key is present — it matches by
 * meaning, respects negation, and understands name-only rules; deterministic
 * keyword matching covers the no-key/offline case and any LLM failure. Never
 * throws for matching problems — a total failure returns an empty list so the
 * render still proceeds. Occurrence selection ("first time only") is applied
 * deterministically inside validateAndCleanEvents, never by the model.
 */
export async function generateOverlayTimeline(
  transcript: Transcript,
  assets: OverlayAsset[],
  rules: OverlayRule[],
  opts: CleanOpts,
  onProgress?: ProgressFn
): Promise<OverlayGenResult> {
  const log: string[] = []
  const sentences = chunkTranscript(transcript)
  const assetIds = new Set(assets.map((a) => a.id))
  const activeRules = deriveInstructions(rules.filter((r) => assetIds.has(r.overlayId)), assets)
  log.push(`overlay rules received: ${rules.length} (active: ${activeRules.length})`)
  log.push(`transcript chunks processed: ${sentences.length}`)
  if (activeRules.length === 0 || sentences.length === 0) {
    return { events: [], via: 'none', log }
  }

  let cleaned: ReturnType<typeof validateAndCleanEvents> | null = null
  let via: 'llm' | 'keyword' = 'keyword'

  // SEMANTIC FIRST when a key is available: paraphrases, name-only topics and
  // negative mentions are exactly what keywords get wrong.
  if (claudeAvailable()) {
    try {
      onProgress?.(30, 'Matching overlays with the AI…')
      const llm = await callLLMForOverlayRules(sentences, activeRules)
      const llmCleaned = validateAndCleanEvents(llm.events, activeRules, opts)
      log.push(`AI match: ${llm.events.length} candidate(s), kept ${llmCleaned.events.length}`)
      for (const l of llm.lowConfidence.slice(0, 10)) log.push(`  low confidence, dropped: ${l}`)
      if (llmCleaned.events.length > 0) { cleaned = llmCleaned; via = 'llm' }
    } catch (e) {
      log.push(`AI match failed, falling back to keywords: ${(e as Error).message}`)
    }
  }

  // LOCAL keyword matching: the offline path, and the fallback when the AI
  // found nothing or errored.
  if (!cleaned || cleaned.events.length === 0) {
    onProgress?.(70, 'Matching overlays locally…')
    const localRaw = keywordFallback(activeRules, sentences)
    const localCleaned = validateAndCleanEvents(localRaw, activeRules, opts)
    log.push(`local keyword match: ${localRaw.length} candidate(s), kept ${localCleaned.events.length}`)
    if (!cleaned || localCleaned.events.length > 0) { cleaned = localCleaned; via = 'keyword' }
    if (localCleaned.events.length === 0 && !claudeAvailable()) log.push('no local match; no API key for semantic matching')
  }

  for (const r of cleaned.rejected.slice(0, 25)) log.push(`  rejected: ${r}`)
  onProgress?.(100, cleaned.events.length ? `Placed ${cleaned.events.length} overlay(s)` : 'No overlay matches')
  return { events: cleaned.events, via: cleaned.events.length ? via : 'none', log }
}
