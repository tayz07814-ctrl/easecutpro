// AI rule interpretation for overlay placement. The AI ONLY produces structured
// timeline data (overlay events) — it never edits the video. Provider logic is
// isolated here (reuses the existing Claude client); the renderer/store apply the
// data. Falls back to deterministic keyword matching when no LLM key is present
// or the call fails, so generation is reliable and never blocks a render.

import { getAnthropic, claudeAvailable } from './claude'
import { chunkTranscript, keywordFallback, validateAndCleanEvents } from '../shared/overlay'
import type { CleanOpts } from '../shared/overlay'
import type {
  OverlayAsset, OverlayEvent, OverlayGenResult, OverlayRule, Transcript
} from '../shared/types'

type ProgressFn = (pct: number, msg?: string) => void

const MODEL = 'claude-opus-4-8'

const SYSTEM_PROMPT = `You place product-overlay image cards onto a talking-head video by matching each card's RULE to the transcript sentence where that topic is actually discussed.

You receive numbered SENTENCES (with an index) and a list of overlay RULES (each with an overlayId, a name, and a natural-language instruction describing when to show it). Return the sentences where each rule clearly applies.

RULES (precision over recall):
- Match a rule to a sentence ONLY when the sentence clearly discusses what the instruction describes. Judge by MEANING (paraphrases count), not just keywords. When unsure, do NOT match.
- Return the SENTENCE INDEX, never a timestamp.
- Place each overlay sparingly — usually once, at most a few times for a strongly repeated theme. Never spam.
- Do not match a rule to a sentence that only mentions the topic in passing or negatively.

OUTPUT: return ONLY a JSON object, no prose:
{"events":[{"overlayId":"<id>","sentenceIndex":<int>,"reason":"<short quote/why>"}]}
If nothing matches, return {"events":[]}.`

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
): Promise<Array<Partial<OverlayEvent>>> {
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
  for (const e of parsed?.events ?? []) {
    const idx = Number(e?.sentenceIndex)
    if (!Number.isInteger(idx) || idx < 0 || idx >= sentences.length) continue // no hallucinated times
    out.push({
      overlayId: String(e?.overlayId ?? ''),
      start: sentences[idx].start,
      end: sentences[idx].end,
      reason: String(e?.reason ?? ''),
      source: 'llm'
    })
  }
  return out
}

/**
 * Turn overlay assets + rules + a transcript into validated overlay events.
 * Never throws for matching problems — on any LLM failure it falls back to
 * keyword matching, and a total failure returns an empty list so the render
 * still proceeds.
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
  const activeRules = rules.filter((r) => assetIds.has(r.overlayId) && r.instruction.trim())
  log.push(`overlay rules received: ${rules.length} (active: ${activeRules.length})`)
  log.push(`transcript chunks processed: ${sentences.length}`)
  if (activeRules.length === 0 || sentences.length === 0) {
    return { events: [], via: 'none', log }
  }

  // LOCAL FIRST: deterministic keyword matching, fully offline (no API call).
  onProgress?.(20, 'Matching overlays locally…')
  const localRaw = keywordFallback(activeRules, sentences)
  let cleaned = validateAndCleanEvents(localRaw, activeRules, opts)
  let via: 'llm' | 'keyword' = 'keyword'
  log.push(`local keyword match: ${localRaw.length} candidate(s), kept ${cleaned.events.length}`)

  // FALLBACK TO API only if local placed nothing AND a Claude key is available.
  if (cleaned.events.length === 0 && claudeAvailable()) {
    try {
      onProgress?.(55, 'No local match — asking the AI…')
      const llmRaw = await callLLMForOverlayRules(sentences, activeRules)
      const llmCleaned = validateAndCleanEvents(llmRaw, activeRules, opts)
      log.push(`API fallback: ${llmRaw.length} candidate(s), kept ${llmCleaned.events.length}`)
      if (llmCleaned.events.length > 0) { cleaned = llmCleaned; via = 'llm' }
    } catch (e) {
      log.push(`API fallback failed: ${(e as Error).message}`)
    }
  } else if (cleaned.events.length === 0) {
    log.push('no local match; no API key for fallback')
  }

  for (const r of cleaned.rejected.slice(0, 25)) log.push(`  rejected: ${r}`)
  onProgress?.(100, cleaned.events.length ? `Placed ${cleaned.events.length} overlay(s)` : 'No overlay matches')
  return { events: cleaned.events, via: cleaned.events.length ? via : 'none', log }
}
