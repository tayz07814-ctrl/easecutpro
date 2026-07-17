// EaseCutPro — semantic overlay matcher edge function.
//
// Matches named overlay cards to the transcript sentences where their topic is
// actually discussed (by MEANING, not just keywords), so the cloud build places
// overlays as well as the desktop app does. The model ONLY proposes sentence
// indices + confidence; the browser maps index -> time, applies the per-rule
// occurrence (first/last/every) and validates. On any provider problem this
// returns { raw: null } so the browser falls back to keyword matching and the
// Generate action always completes.
//
// Input:  { payload: { sentences: [{index,text}], rules: [{overlayId,name,instruction}] } }
// Output: { raw: <model JSON text> | null, judge }
//
// Provider order: Anthropic Claude Opus -> OpenAI gpt-4o-mini -> none. Reuses the
// same secrets as llm-judge / procut-judge (ANTHROPIC_API_KEY, OPENAI_API_KEY).
//
// SYSTEM is a MIRRORED copy of OVERLAY_MATCH_SYSTEM in src/shared/overlay.ts
// (Deno can't import from src) — keep them in sync.

import { createClient } from 'npm:@supabase/supabase-js@2'

// Self-contained CORS helpers (mirror of ../_shared/http.ts) so this function
// deploys as a single standalone file.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}
function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null
}

const SYSTEM = `You place product-overlay image cards onto a talking-head video by matching each card's RULE to the transcript sentences where that topic is actually discussed.

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

interface Sentence { index: number; text: string }
interface Rule { overlayId: string; name: string; instruction: string; description?: string }

function buildUserMessage(sentences: Sentence[], rules: Rule[]): string {
  const s = sentences.map((x) => `[${x.index}] ${x.text}`).join('\n')
  const r = rules
    .map((x) => `- overlayId=${x.overlayId} | "${x.name}"${x.description ? ` | shows: ${x.description}` : ''} | ${x.instruction}`)
    .join('\n')
  return `SENTENCES:\n${s}\n\nOVERLAY RULES:\n${r}\n\nReturn JSON only.`
}

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return !!data.user
}

async function anthropicMatch(key: string, user: string): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }]
    })
  })
  if (!r.ok) throw new Error(`Anthropic: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const d = (await r.json()) as { content: { type: string; text?: string }[] }
  return d.content.map((b) => b.text ?? '').join('')
}

async function openaiMatch(key: string, user: string): Promise<string> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user }
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
    const sentences: Sentence[] = Array.isArray(payload?.sentences) ? payload.sentences : []
    const rules: Rule[] = Array.isArray(payload?.rules) ? payload.rules : []
    if (!sentences.length || !rules.length) return json({ error: 'missing sentences or rules' }, 400)
    const user = buildUserMessage(sentences, rules)

    const anthropic = Deno.env.get('ANTHROPIC_API_KEY')
    const openai = Deno.env.get('OPENAI_API_KEY')
    if (anthropic) {
      try {
        return json({ raw: await anthropicMatch(anthropic, user), judge: 'anthropic:claude-opus' })
      } catch (e) {
        console.warn('[overlay-match] anthropic failed:', (e as Error).message)
        if (openai) {
          try {
            return json({ raw: await openaiMatch(openai, user), judge: 'openai:gpt-4o-mini' })
          } catch (e2) {
            console.warn('[overlay-match] openai fallback failed:', (e2 as Error).message)
          }
        }
        return json({ raw: null, judge: 'anthropic:claude-opus' })
      }
    }
    if (openai) {
      try {
        return json({ raw: await openaiMatch(openai, user), judge: 'openai:gpt-4o-mini' })
      } catch (e) {
        console.warn('[overlay-match] openai failed:', (e as Error).message)
        return json({ raw: null, judge: 'openai:gpt-4o-mini' })
      }
    }
    return json({ raw: null, judge: 'none' })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
