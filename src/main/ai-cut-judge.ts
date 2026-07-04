/**
 * AI cut judge for Smart Smooth Cut (beta) — provider abstraction.
 *
 * The AI NEVER edits video. It receives structured pause_analysis JSON and must
 * return STRICT JSON decisions ({keep|shorten|remove, keep_ms, reason}); the
 * pure validator in shared/smartsmooth.ts clamps/rejects anything else, and any
 * failure here degrades to rules-only (the job never crashes).
 *
 * Provider chain: Anthropic Claude (reuses claude.ts key resolution) -> none
 * (mock: empty decisions => caller's deterministic fallback).
 * TODO: add an OpenAI provider via openai.ts if a Claude key is absent.
 */
import { claudeAvailable, getAnthropic } from './claude'

const MODEL = 'claude-opus-4-8'

const SYSTEM = `You are a video-editing pause judge. You receive JSON describing ambiguous pauses in a talking video (transcript context, duration, audio-energy summary, repeated-phrase likelihood, candidate type) plus an editing style.

Decide for EACH pause whether the edit should:
- "keep"    — an intentional/dramatic/emotional pause, or natural pacing
- "shorten" — too long for the style, but a beat should remain (set keep_ms)
- "remove"  — awkward dead air or a failed-take reset with no value

Style guidance: "natural" keeps more pauses and preserves breathing/emotion; "tiktok_smooth" removes awkward dead air but keeps short emotional pauses; "aggressive" cuts hard for fast pacing.

Reply with VALID JSON ONLY (no prose, no markdown fences), exactly:
{"decisions":[{"pause_id":"pause_001","decision":"shorten","keep_ms":350,"reason":"..."}]}
keep_ms is required only for "shorten". Every pause_id you were given must appear exactly once.`

export interface JudgePayload {
  editingStyle: string
  videoDuration: number
  pauseCandidates: unknown[]
}

/** True when some AI judge provider is configured. */
export function cutJudgeAvailable(): boolean {
  return claudeAvailable()
}

/**
 * Run the judge. Returns the raw model text (expected to be JSON — the shared
 * validator handles anything malformed). Returns '{"decisions":[]}' when no
 * provider is configured, so callers transparently use rules-only.
 */
export async function judgeCuts(payload: JudgePayload): Promise<string> {
  if (!claudeAvailable()) return '{"decisions":[]}' // mock provider: rules-only
  const client = getAnthropic()
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(payload) }]
  })
  const block = res.content.find((b) => b.type === 'text')
  return block && block.type === 'text' ? block.text : '{"decisions":[]}'
}
