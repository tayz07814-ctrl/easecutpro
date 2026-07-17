// Cloud overlay matching. Prefers SEMANTIC matching via the `overlay-match` edge
// function (Claude Opus — paraphrases, negation, name-only topics) and falls back
// to deterministic keyword matching when the user is offline, the function errors,
// or nothing matched. Mirrors the desktop flow in src/main/overlay-rules.ts; the
// prompt + response parsing are the SAME shared code (src/shared/overlay.ts), so
// cloud and desktop place identically. The model only proposes sentence indices;
// time mapping, occurrence selection and validation stay deterministic here.

import { invokeEdge } from './supabase'
import {
  chunkTranscript, deriveInstructions, keywordOverlayTimeline,
  parseOverlayLlmResponse, validateAndCleanEvents, parseOverlaySuggestions
} from '@shared/overlay'
import type { CleanOpts } from '@shared/overlay'
import type { OverlayAsset, OverlayGenResult, OverlayRule, OverlaySuggestResult, Transcript } from '@shared/types'

interface EdgeRes { raw: string | null; judge?: string }

let suggestUidN = 0
const suggestUid = (): string => `sg_${suggestUidN++}`

/** Cloud "Suggest": proactive placements via the overlay-suggest edge function.
 *  No local fallback — Suggest is an AI-only, discovery feature. */
export async function suggestOverlaysCloud(
  transcript: Transcript,
  assets: OverlayAsset[],
  opts: CleanOpts
): Promise<OverlaySuggestResult> {
  const log: string[] = []
  const sentences = chunkTranscript(transcript)
  const library = assets.map((a) => ({ overlayId: a.id, name: a.name, description: a.description }))
  log.push(`suggest: ${sentences.length} sentence(s), ${library.length} overlay(s) in library`)
  if (sentences.length === 0 || library.length === 0) return { suggestions: [], via: 'none', log }
  try {
    const res = await invokeEdge<EdgeRes>('overlay-suggest', {
      payload: { sentences: sentences.map((s) => ({ index: s.index, text: s.text })), library }
    })
    if (!res?.raw) { log.push('Suggest unavailable (no key/provider)'); return { suggestions: [], via: 'none', log } }
    const { suggestions, log: plog } = parseOverlaySuggestions(res.raw, sentences, assets, opts, suggestUid)
    log.push(`AI suggest (${res.judge ?? 'edge'}): ${suggestions.length} suggestion(s)`)
    log.push(...plog)
    return { suggestions, via: suggestions.length ? 'llm' : 'none', log }
  } catch (e) {
    log.push(`Suggest failed: ${(e as Error).message}`)
    return { suggestions: [], via: 'none', log }
  }
}

export async function generateOverlaysCloud(
  transcript: Transcript,
  assets: OverlayAsset[],
  rules: OverlayRule[],
  opts: CleanOpts
): Promise<OverlayGenResult> {
  const log: string[] = []
  const sentences = chunkTranscript(transcript)
  const assetIds = new Set(assets.map((a) => a.id))
  const activeRules = deriveInstructions(rules.filter((r) => assetIds.has(r.overlayId)), assets)
  log.push(`overlay rules received: ${rules.length} (active: ${activeRules.length})`)
  log.push(`transcript chunks processed: ${sentences.length}`)
  if (activeRules.length === 0 || sentences.length === 0) return { events: [], via: 'none', log }

  // SEMANTIC FIRST: the edge function reasons over the transcript by meaning.
  try {
    const descById = new Map(assets.map((a) => [a.id, a.description]))
    const res = await invokeEdge<EdgeRes>('overlay-match', {
      payload: {
        sentences: sentences.map((s) => ({ index: s.index, text: s.text })),
        rules: activeRules.map((r) => ({ overlayId: r.overlayId, name: r.name, instruction: r.instruction, description: descById.get(r.overlayId) }))
      }
    })
    if (res?.raw) {
      const { events, lowConfidence } = parseOverlayLlmResponse(res.raw, sentences)
      const cleaned = validateAndCleanEvents(events, activeRules, opts)
      log.push(`AI match (${res.judge ?? 'edge'}): ${events.length} candidate(s), kept ${cleaned.events.length}`)
      for (const l of lowConfidence.slice(0, 10)) log.push(`  low confidence, dropped: ${l}`)
      for (const r of cleaned.rejected.slice(0, 25)) log.push(`  rejected: ${r}`)
      if (cleaned.events.length > 0) return { events: cleaned.events, via: 'llm', log }
      log.push('AI matched nothing — falling back to keywords')
    } else {
      log.push('AI matcher unavailable (no key/provider) — using keywords')
    }
  } catch (e) {
    log.push(`AI matcher failed, using keywords: ${(e as Error).message}`)
  }

  // FALLBACK: deterministic keyword matching (fully offline).
  const kw = keywordOverlayTimeline(transcript, assets, rules, opts)
  return { events: kw.events, via: kw.events.length ? 'keyword' : 'none', log: [...log, ...kw.log] }
}
