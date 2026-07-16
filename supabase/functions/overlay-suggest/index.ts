// EaseCutPro — proactive overlay SUGGESTER edge function ("Suggest" — the paid,
// discovery tier). Reads the whole transcript + the creator's overlay library and
// PROPOSES overlay↔moment placements for review; unlike overlay-match it needs no
// creator-authored rules. The model only proposes sentence indices + confidence;
// the browser maps index -> time, avoids cuts, paces and caps (deterministic),
// then shows a review list. On any provider problem this returns { raw: null } so
// the UI degrades gracefully.
//
// Input:  { payload: { sentences: [{index,text}], library: [{overlayId,name}] } }
// Output: { raw: <model JSON text> | null, judge }
//
// Provider order: Anthropic Claude Opus -> OpenAI gpt-4o-mini -> none. Reuses the
// same secrets as overlay-match / llm-judge (ANTHROPIC_API_KEY, OPENAI_API_KEY).
//
// SYSTEM is a MIRRORED copy of OVERLAY_SUGGEST_SYSTEM in src/shared/overlay.ts
// (Deno can't import from src) — keep them in sync.

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null
}

const SYSTEM = `You are a video editor's overlay assistant. You read a full talking-head transcript and a LIBRARY of the creator's own overlay image cards, and you PROPOSE where each card should appear — like a creative director planning B-roll.

You receive numbered SENTENCES (the whole video, in order) and an OVERLAY LIBRARY (each item has an overlayId and a name). Propose placements.

HOW TO THINK:
1. Read the whole video as a story and find its BEATS — the hook, the problem, the product/point, proof or examples, and the call-to-action at the end.
2. Find the OVERLAY-WORTHY moments: a specific claim, a number/price, a product or feature mention, an emotional peak, or the CTA. Not every sentence deserves an overlay.
3. For each such moment, pick the library card whose NAME best fits it (judge by meaning; a card named "No Bloating" fits a sentence about a flatter stomach). A call-to-action card (CTA, subscribe, link, discount) belongs on the closing lines.

RULES:
- Only propose a card when it genuinely fits the moment. Precision over recall — a few great placements beat many weak ones.
- Space them out across the video; do not stack overlays or crowd one section.
- Return the SENTENCE INDEX of the moment, never a timestamp.
- Choose a POSITION that won't cover the speaker's face: prefer top_center or bottom_center (use a corner only when it clearly fits).
- Give each proposal a confidence 0..1 and a short reason a creator would understand ("you introduce the discount here").
- Do NOT propose a card for a sentence that only mentions the topic in passing or negatively.

OUTPUT: return ONLY a JSON object, no prose:
{"suggestions":[{"overlayId":"<id>","sentenceIndex":<int>,"position":"top_center|bottom_center|center|top_left|top_right|bottom_left|bottom_right","confidence":<0..1>,"reason":"<why here>"}]}
If nothing is worth an overlay, return {"suggestions":[]}.`

interface Sentence { index: number; text: string }
interface LibItem { overlayId: string; name: string }

function buildUserMessage(sentences: Sentence[], library: LibItem[]): string {
  const s = sentences.map((x) => `[${x.index}] ${x.text}`).join('\n')
  const l = library.map((x) => `- overlayId=${x.overlayId} | "${x.name}"`).join('\n')
  return `SENTENCES:\n${s}\n\nOVERLAY LIBRARY:\n${l}\n\nReturn JSON only.`
}

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return !!data.user
}

async function anthropicSuggest(key: string, user: string): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 4000, system: SYSTEM, messages: [{ role: 'user', content: user }] })
  })
  if (!r.ok) throw new Error(`Anthropic: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const d = (await r.json()) as { content: { type: string; text?: string }[] }
  return d.content.map((b) => b.text ?? '').join('')
}

async function openaiSuggest(key: string, user: string): Promise<string> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini', max_tokens: 4000, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }]
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
    const library: LibItem[] = Array.isArray(payload?.library) ? payload.library : []
    if (!sentences.length || !library.length) return json({ error: 'missing sentences or library' }, 400)
    const user = buildUserMessage(sentences, library)

    const anthropic = Deno.env.get('ANTHROPIC_API_KEY')
    const openai = Deno.env.get('OPENAI_API_KEY')
    if (anthropic) {
      try {
        return json({ raw: await anthropicSuggest(anthropic, user), judge: 'anthropic:claude-opus' })
      } catch (e) {
        console.warn('[overlay-suggest] anthropic failed:', (e as Error).message)
        if (openai) {
          try {
            return json({ raw: await openaiSuggest(openai, user), judge: 'openai:gpt-4o-mini' })
          } catch (e2) {
            console.warn('[overlay-suggest] openai fallback failed:', (e2 as Error).message)
          }
        }
        return json({ raw: null, judge: 'anthropic:claude-opus' })
      }
    }
    if (openai) {
      try {
        return json({ raw: await openaiSuggest(openai, user), judge: 'openai:gpt-4o-mini' })
      } catch (e) {
        console.warn('[overlay-suggest] openai failed:', (e as Error).message)
        return json({ raw: null, judge: 'openai:gpt-4o-mini' })
      }
    }
    return json({ raw: null, judge: 'none' })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
