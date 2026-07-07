// Retake-Aware Cut Beta — optional LLM reviewer.
//
// The LLM never edits the video and never sees it: it receives the STRUCTURED
// retake groups + ambiguous filler candidates as JSON and may only pick a
// keep_attempt per group / flip a filler classification. Invalid JSON, unknown
// ids or a missing key all degrade to the rule-based decisions — the beta job
// always completes. Providers: Anthropic Claude Haiku -> OpenAI gpt-4o-mini ->
// none (RETAKE_LLM=off disables; RETAKE_LLM=mock returns canned approvals for
// offline testing).

import type { RetakeGroup, FillerDecision, LlmDecisions } from '../../shared/retakeaware/types'
import { resolveAnthropicKey, getAnthropic } from '../claude'
import { openaiAvailable, getOpenAI } from '../openai'

export interface LlmJudge {
  name: string
  review(payload: ReviewPayload): Promise<string> // raw model text (JSON expected)
}

export interface ReviewPayload {
  transcriptContext: string
  retakeGroups: RetakeGroup[]
  fillerCandidates: FillerDecision[]
  editingStyle: string
}

const SYSTEM = `You review video-editing candidates for a talking-head editor. You get retake groups (repeated attempts at the same line) and filler-word candidates.
Rules:
- For each retake group pick exactly ONE keep_attempt from the listed attempt_ids. NEVER combine words from different attempts.
- Prefer the most complete, fluent, latest attempt.
- For fillers: "keep" natural emphasis (e.g. "Honestly, this changed everything"), "remove" ugly hesitations (uh/um clusters), "shorten" stutters, "retake_marker" spoken commands like "let me say that again".
Reply with ONLY a JSON object: {"retake_group_decisions":[{"retake_group_id":"","keep_attempt":"","remove_attempts":[""],"reason":""}],"filler_decisions":[{"filler_id":"","decision":"keep|remove|shorten|retake_marker","reason":""}]} — no prose, no markdown fences.`

class AnthropicJudge implements LlmJudge {
  name = 'anthropic:claude-haiku-4-5'
  async review(payload: ReviewPayload): Promise<string> {
    const client = getAnthropic()
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }]
    })
    return res.content.map((b) => ('text' in b ? b.text : '')).join('')
  }
}

class OpenAIJudge implements LlmJudge {
  name = 'openai:gpt-4o-mini'
  async review(payload: ReviewPayload): Promise<string> {
    const client = getOpenAI()
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    })
    return res.choices[0]?.message?.content ?? ''
  }
}

class MockJudge implements LlmJudge {
  name = 'mock'
  async review(payload: ReviewPayload): Promise<string> {
    // Canned: approve the rule engine's own choices verbatim.
    return JSON.stringify({
      retake_group_decisions: payload.retakeGroups.map((g) => ({
        retake_group_id: g.retake_group_id,
        keep_attempt: g.keep_attempt,
        remove_attempts: g.remove_attempts,
        reason: 'mock approval'
      })),
      filler_decisions: []
    } satisfies LlmDecisions)
  }
}

export function pickJudge(): LlmJudge | null {
  const pref = (process.env.RETAKE_LLM || '').toLowerCase()
  if (pref === 'off') return null
  if (pref === 'mock') return new MockJudge()
  if (resolveAnthropicKey()) return new AnthropicJudge()
  if (openaiAvailable()) return new OpenAIJudge()
  return null
}

/** Extract + validate the model's JSON; null on ANY problem (rules stand). */
export function parseLlmDecisions(raw: string, warnings: string[]): LlmDecisions | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('no JSON object in reply')
    const j = JSON.parse(m[0]) as LlmDecisions
    if (!Array.isArray(j.retake_group_decisions ?? []) || !Array.isArray(j.filler_decisions ?? [])) {
      throw new Error('wrong shape')
    }
    return { retake_group_decisions: j.retake_group_decisions ?? [], filler_decisions: j.filler_decisions ?? [] }
  } catch (e) {
    warnings.push(`LLM returned unusable JSON — using rule-based decisions (${(e as Error).message})`)
    console.warn('[retake-aware-beta] LLM JSON invalid, rules stand:', (e as Error).message)
    return null
  }
}

/** Run the optional review; never throws — the job completes on rules alone. */
export async function reviewRetakeGroups(
  payload: ReviewPayload,
  warnings: string[]
): Promise<{ decisions: LlmDecisions | null; judge: string }> {
  const judge = pickJudge()
  if (!judge) {
    warnings.push('No LLM key configured — retake decisions are rule-based only.')
    return { decisions: null, judge: 'none' }
  }
  if (!payload.retakeGroups.length && !payload.fillerCandidates.length) {
    return { decisions: null, judge: judge.name } // nothing ambiguous to review
  }
  try {
    const raw = await judge.review(payload)
    return { decisions: parseLlmDecisions(raw, warnings), judge: judge.name }
  } catch (e) {
    warnings.push(`LLM review failed (${(e as Error).message}) — using rule-based decisions.`)
    console.warn('[retake-aware-beta] LLM review failed:', (e as Error).message)
    return { decisions: null, judge: judge.name }
  }
}
