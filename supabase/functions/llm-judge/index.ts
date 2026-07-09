// EaseCutPro — Retake β LLM judge edge function.
//
// The judge never sees audio/video: it receives the STRUCTURED retake groups +
// ambiguous filler candidates as JSON and may only pick a keep_attempt per
// group / flip a filler classification. The browser parses `raw` with the same
// parseLlmDecisions as the PC engine and degrades to rule-based decisions on
// any problem — this function therefore returns { raw: null } rather than
// erroring whenever a provider misbehaves, so the cut job always completes.
//
// Provider order mirrors src/main/retakeaware/llm.ts: Anthropic Claude Haiku ->
// OpenAI gpt-4o-mini -> none. SYSTEM prompt is a mirrored copy of llm.ts (keep
// them in sync).
//
// Secrets (supabase secrets set): ANTHROPIC_API_KEY, OPENAI_API_KEY (optional).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { json, preflight } from '../_shared/http.ts'

const SYSTEM = `You review video-editing candidates for a talking-head editor. You get retake groups (repeated attempts at the same line) and filler-word candidates.
Rules:
- For each retake group pick exactly ONE keep_attempt from the listed attempt_ids. NEVER combine words from different attempts.
- Prefer the most complete, fluent, latest attempt.
- Groups marked "provisional": true are UNCERTAIN detections. Decide honestly: if the two lines are really the same take retried (a flub + its redo), affirm with a keep_attempt; if they are deliberate content (parallel phrasing, intentional emphasis/repetition, a list), reject with {"retake_group_id":"…","not_a_retake":true,"reason":"…"}. When unsure, reject — cutting real content is worse than keeping a repeat.
- For fillers: "keep" natural emphasis (e.g. "Honestly, this changed everything"), "remove" ugly hesitations (uh/um clusters), "shorten" stutters, "retake_marker" spoken commands like "let me say that again".
Reply with ONLY a JSON object: {"retake_group_decisions":[{"retake_group_id":"","keep_attempt":"","remove_attempts":[""],"reason":"","not_a_retake":false}],"filler_decisions":[{"filler_id":"","decision":"keep|remove|shorten|retake_marker","reason":""}]} — no prose, no markdown fences.`

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return !!data.user
}

async function anthropicReview(key: string, payload: unknown): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }]
    })
  })
  if (!r.ok) throw new Error(`Anthropic: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const d = (await r.json()) as { content: { type: string; text?: string }[] }
  return d.content.map((b) => b.text ?? '').join('')
}

async function openaiReview(key: string, payload: unknown): Promise<string> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    })
  })
  if (!r.ok) throw new Error(`OpenAI: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const d = (await r.json()) as { choices?: { message?: { content?: string } }[] }
  return d.choices?.[0]?.message?.content ?? ''
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const { payload } = await req.json().catch(() => ({ payload: null }))
    if (!payload) return json({ error: 'missing payload' }, 400)

    const anthropic = Deno.env.get('ANTHROPIC_API_KEY')
    const openai = Deno.env.get('OPENAI_API_KEY')
    if (anthropic) {
      try {
        return json({ raw: await anthropicReview(anthropic, payload), judge: 'anthropic:claude-haiku-4-5' })
      } catch (e) {
        console.warn('[llm-judge] anthropic failed:', (e as Error).message)
        if (openai) {
          try {
            return json({ raw: await openaiReview(openai, payload), judge: 'openai:gpt-4o-mini' })
          } catch (e2) {
            console.warn('[llm-judge] openai fallback failed:', (e2 as Error).message)
          }
        }
        return json({ raw: null, judge: 'anthropic:claude-haiku-4-5' })
      }
    }
    if (openai) {
      try {
        return json({ raw: await openaiReview(openai, payload), judge: 'openai:gpt-4o-mini' })
      } catch (e) {
        console.warn('[llm-judge] openai failed:', (e as Error).message)
        return json({ raw: null, judge: 'openai:gpt-4o-mini' })
      }
    }
    return json({ raw: null, judge: 'none' })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
