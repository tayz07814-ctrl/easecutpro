// AI rule interpretation for overlay placement. The AI ONLY produces structured
// timeline data (overlay events) — it never edits the video. Provider logic is
// isolated here (reuses the existing Claude client); the renderer/store apply the
// data. Falls back to deterministic keyword matching when no LLM key is present
// or the call fails, so generation is reliable and never blocks a render.

import { getAnthropic, claudeAvailable } from './claude'
import {
  chunkTranscript, keywordFallback, validateAndCleanEvents, deriveInstructions,
  OVERLAY_MATCH_SYSTEM, buildOverlayUserMessage, parseOverlayLlmResponse
} from '../shared/overlay'
import type { CleanOpts, Sentence } from '../shared/overlay'
import type {
  OverlayAsset, OverlayEvent, OverlayGenResult, OverlayRule, Transcript
} from '../shared/types'

type ProgressFn = (pct: number, msg?: string) => void

const MODEL = 'claude-opus-4-8'

/** Provider-isolated LLM call: sentences + rules -> raw events (sentence-anchored).
 *  Prompt + parsing are shared with the cloud edge function (src/shared/overlay.ts). */
async function callLLMForOverlayRules(
  sentences: Sentence[],
  rules: OverlayRule[]
): Promise<{ events: Array<Partial<OverlayEvent>>; lowConfidence: string[] }> {
  const client = getAnthropic()
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: OVERLAY_MATCH_SYSTEM,
    messages: [{ role: 'user', content: buildOverlayUserMessage(sentences, rules) }]
  })
  const block = res.content.find((b) => b.type === 'text')
  return parseOverlayLlmResponse(block && block.type === 'text' ? block.text : '', sentences)
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
