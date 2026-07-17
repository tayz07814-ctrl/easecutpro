// AI rule interpretation for overlay placement. The AI ONLY produces structured
// timeline data (overlay events) — it never edits the video. Provider logic is
// isolated here (reuses the existing Claude client); the renderer/store apply the
// data. Falls back to deterministic keyword matching when no LLM key is present
// or the call fails, so generation is reliable and never blocks a render.

import { getAnthropic, claudeAvailable } from './claude'
import {
  chunkTranscript, keywordFallback, validateAndCleanEvents, deriveInstructions,
  OVERLAY_MATCH_SYSTEM, buildOverlayUserMessage, parseOverlayLlmResponse,
  OVERLAY_SUGGEST_SYSTEM, buildSuggestUserMessage, parseOverlaySuggestions
} from '../shared/overlay'
import type { CleanOpts, Sentence } from '../shared/overlay'
import type {
  OverlayAsset, OverlayEvent, OverlayGenResult, OverlayRule, OverlaySuggestResult,
  OverlayThumb, Transcript
} from '../shared/types'

type ProgressFn = (pct: number, msg?: string) => void

const MODEL = 'claude-opus-4-8'

/** Provider-isolated LLM call: sentences + rules -> raw events (sentence-anchored).
 *  Prompt + parsing are shared with the cloud edge function (src/shared/overlay.ts).
 *  `descById` carries each overlay's vision description (v1.5) into the prompt. */
async function callLLMForOverlayRules(
  sentences: Sentence[],
  rules: OverlayRule[],
  descById: Map<string, string | undefined>
): Promise<{ events: Array<Partial<OverlayEvent>>; lowConfidence: string[] }> {
  const client = getAnthropic()
  const view = rules.map((r) => ({ overlayId: r.overlayId, name: r.name, instruction: r.instruction, description: descById.get(r.overlayId) }))
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: OVERLAY_MATCH_SYSTEM,
    messages: [{ role: 'user', content: buildOverlayUserMessage(sentences, view) }]
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
  const descById = new Map(assets.map((a) => [a.id, a.description]))

  // SEMANTIC FIRST when a key is available: paraphrases, name-only topics and
  // negative mentions are exactly what keywords get wrong.
  if (claudeAvailable()) {
    try {
      onProgress?.(30, 'Matching overlays with the AI…')
      const llm = await callLLMForOverlayRules(sentences, activeRules, descById)
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

/**
 * "Suggest": read the whole transcript + the overlay library and PROPOSE
 * overlay↔moment placements for the creator to review. No rules required — the
 * model chooses which cards fit and where. Prompt + parsing are shared with the
 * cloud edge function. Never throws: returns an empty list on any problem so the
 * UI degrades gracefully. The model only proposes sentence indices; time mapping,
 * cut-avoidance, pacing and caps are deterministic (parseOverlaySuggestions).
 */
export async function suggestOverlayTimeline(
  transcript: Transcript,
  assets: OverlayAsset[],
  opts: CleanOpts,
  onProgress?: ProgressFn
): Promise<OverlaySuggestResult> {
  const log: string[] = []
  const sentences = chunkTranscript(transcript)
  const library = assets.map((a) => ({ overlayId: a.id, name: a.name, description: a.description }))
  log.push(`suggest: ${sentences.length} sentence(s), ${library.length} overlay(s) in library`)
  if (sentences.length === 0 || library.length === 0) return { suggestions: [], via: 'none', log }
  if (!claudeAvailable()) {
    log.push('Suggest needs an AI key (no local fallback)')
    return { suggestions: [], via: 'none', log }
  }
  try {
    onProgress?.(30, 'Reading the video…')
    const client = getAnthropic()
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: OVERLAY_SUGGEST_SYSTEM,
      messages: [{ role: 'user', content: buildSuggestUserMessage(sentences, library) }]
    })
    const block = res.content.find((b) => b.type === 'text')
    let i = 0
    const { suggestions, log: plog } = parseOverlaySuggestions(
      block && block.type === 'text' ? block.text : '', sentences, assets, opts, () => `sg_${i++}`
    )
    log.push(...plog)
    onProgress?.(100, suggestions.length ? `${suggestions.length} suggestion(s)` : 'No suggestions')
    return { suggestions, via: suggestions.length ? 'llm' : 'none', log }
  } catch (e) {
    log.push(`suggest failed: ${(e as Error).message}`)
    return { suggestions: [], via: 'none', log }
  }
}

/** Vision pass: describe what an overlay IMAGE depicts, so matching/suggestion can
 *  key on the card's CONTENT (a "50% OFF" badge) not just its filename. One short
 *  sentence; empty string on any problem so callers fall back to the name. */
export async function describeOverlayImage(imageBase64: string, mediaType: string): Promise<{ description: string }> {
  if (!claudeAvailable() || !imageBase64) return { description: '' }
  try {
    const client = getAnthropic()
    const media = /^image\/(png|jpeg|gif|webp)$/.test(mediaType) ? mediaType : 'image/png'
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: 'You label overlay graphics for a video editor. Describe what the image DEPICTS in ONE short phrase a matcher can use — the visible text, product, or subject (e.g. "a red \'50% OFF\' discount badge", "a smiling before/after skincare photo"). No preamble, just the phrase.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media as 'image/png', data: imageBase64 } },
          { type: 'text', text: 'Describe this overlay in one short phrase.' }
        ]
      }]
    })
    const block = res.content.find((b) => b.type === 'text')
    const description = (block && block.type === 'text' ? block.text : '').trim().slice(0, 200)
    return { description }
  } catch {
    return { description: '' }
  }
}

/** Moment vision (image-to-image): given a VIDEO FRAME where the creator is
 *  showing something on camera + the creator's own overlay thumbnails, pick which
 *  overlay depicts what's being shown (e.g. an armpit frame -> the "Armpit" overlay).
 *  Returns that overlay's id, or '' when none clearly matches / on any problem.
 *  The model sees the frame first, then each overlay tagged by a LETTER (opaque ids
 *  are never shown to it), and replies with just the letter; we map it back. */
const MOMENT_MATCH_SYSTEM =
  'You match what a video creator is SHOWING on camera to their overlay graphics. ' +
  'The FIRST image is a frame from the video. Each following image is one of the ' +
  "creator's overlay assets, tagged by a letter. Decide which ONE overlay depicts the " +
  'SAME thing shown or pointed to in the video frame (same body part, product, or ' +
  'subject). Reply with ONLY that letter. If none clearly matches, reply "none". ' +
  'Reply with a single token — a letter or "none".'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export async function matchMoment(
  frameBase64: string,
  frameMediaType: string,
  line: string,
  overlays: OverlayThumb[]
): Promise<{ overlayId: string }> {
  if (!claudeAvailable() || !frameBase64 || !overlays?.length) return { overlayId: '' }
  const pool = overlays.slice(0, 24) // bound the prompt (letters + cost)
  const okType = (t: string): t is 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' =>
    /^image\/(png|jpeg|gif|webp)$/.test(t)
  const frameType = okType(frameMediaType) ? frameMediaType : 'image/jpeg'
  try {
    const client = getAnthropic()
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: `Video frame (the creator says: "${line}"):` },
      { type: 'image', source: { type: 'base64', media_type: frameType, data: frameBase64 } }
    ]
    pool.forEach((o, i) => {
      content.push({ type: 'text', text: `Overlay ${LETTERS[i]} — ${o.name || 'untitled'}:` })
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: okType(o.mediaType) ? o.mediaType : 'image/jpeg', data: o.image }
      })
    })
    content.push({
      type: 'text',
      text: 'Which overlay letter depicts what is shown in the video frame? Reply with the letter only, or "none".'
    })
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8,
      system: MOMENT_MATCH_SYSTEM,
      messages: [{ role: 'user', content: content as never }]
    })
    const block = res.content.find((b) => b.type === 'text')
    const text = (block && block.type === 'text' ? block.text : '').trim()
    const m = text.match(/[A-Za-z]/)
    if (!m || /^none/i.test(text)) return { overlayId: '' }
    const idx = LETTERS.indexOf(m[0].toUpperCase())
    return { overlayId: idx >= 0 && idx < pool.length ? pool[idx].id : '' }
  } catch {
    return { overlayId: '' }
  }
}
