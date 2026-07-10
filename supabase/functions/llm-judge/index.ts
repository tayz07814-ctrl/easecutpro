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
- ABANDONED / FALSE starts ARE retakes: if an attempt breaks off mid-thought (ends in "—", or is a short incomplete fragment the speaker immediately re-starts with the same opening words) it is a flub — affirm the group, keep the completed attempt, and put every broken fragment in remove_attempts. Never keep a broken fragment.
- RAMBLING restarts: when the speaker re-starts the SAME line several times before finally completing it (a stutter/ramble like "literally people who— people which are— literally people who inject…"), keep ONLY the last complete attempt and put ALL the earlier partial restarts in remove_attempts — remove the whole messy run as one block, not scattered words.
- Groups marked "provisional": true are UNCERTAIN detections. If the two lines are the same take retried (a flub + its redo, an abandoned/broken-off start, or a rambling restart), affirm with a keep_attempt. If they are deliberate content (parallel phrasing, intentional emphasis/repetition, a list), reject with {"retake_group_id":"…","not_a_retake":true,"reason":"…"}. When GENUINELY unsure between those two, reject — but a clearly broken-off or re-started attempt is not the unsure case; affirm it.
- For fillers: "keep" natural emphasis (e.g. "Honestly, this changed everything"), "remove" ugly hesitations (uh/um clusters), "shorten" stutters, "retake_marker" spoken commands like "let me say that again".
- You may ALSO receive "productionChatterCandidates": ambiguous phrases that might be PRODUCTION CHATTER (not part of the finished video the audience sees) rather than AUDIENCE-DIRECTED content. For each, return cut | keep | needs_review by candidate_id:
  • CUT production chatter — the creator talking about the SHOOT ("are we recording", "start over", "let me say that again", "that was bad"), talking to THEMSELVES / self-correcting ("wait no", "hold on", "what do I say"), or an OFF-CAMERA person directing them ("say the line again but slower", "mention the price", "look at the camera").
  • KEEP audience-directed content — spoken to the viewer/customer or carrying the product/testimonial message ("if you", "you need", "this helps", "I used this"), a complete sentence in the final narrative, OR natural two-person CONTENT dialogue (a testimonial Q&A or skit).
  • SAFETY — never cut natural two-person dialogue that is part of the content; do not cut merely because a second speaker exists; do not cut if removing it would break the surrounding sentence. When genuinely unsure, return "needs_review" (it will be kept).
Reply with ONLY a JSON object: {"retake_group_decisions":[{"retake_group_id":"","keep_attempt":"","remove_attempts":[""],"reason":"","not_a_retake":false}],"filler_decisions":[{"filler_id":"","decision":"keep|remove|shorten|retake_marker","reason":""}],"production_chatter_decisions":[{"candidate_id":"","decision":"cut|keep|needs_review","confidence":0.0,"reason":""}]} — no prose, no markdown fences.`

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
