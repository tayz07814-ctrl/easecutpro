// EaseCutPro — Auto Zoom judge edge function.
//
// Given the ordered CUT clips of an edit (index + transcript text + duration),
// Gemma (OpenRouter) picks which clips deserve a punch-in zoom and how strong.
// Returns { raw, judge } where `raw` is Gemma's JSON string
// ({ zooms:[{ i, level, style }] }); raw:null on any failure so the client falls
// back to a deterministic zoom pass instead of erroring. The API key stays
// server-side (OPEN_ROUTER_KEY) — it is NEVER sent to the browser.

import { createClient } from 'npm:@supabase/supabase-js@2'

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

const BASE_URL = Deno.env.get('AUTOZOOM_BASE_URL') ?? 'https://openrouter.ai/api/v1'
const MODEL = Deno.env.get('AUTOZOOM_MODEL') ?? 'google/gemma-4-31b-it'

// Only these models may be requested per-call; anything else falls to MODEL.
const MODEL_WHITELIST = new Set([
  'google/gemma-4-31b-it',
  'google/gemma-3-27b-it',
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash',
  'meta-llama/llama-4-maverick',
  'deepseek/deepseek-v3.2-exp'
])

function resolveModel(requested: unknown): string {
  return typeof requested === 'string' && MODEL_WHITELIST.has(requested) ? requested : MODEL
}

const SYSTEM = `You are a short-form video editor adding punch-in ZOOMS to a talking-head edit.

INPUT: an ordered JSON array of clip segments, each { "i": index, "t": transcript text, "d": duration in seconds }. The segments are already the cut clips of the video, in order.

TASK: choose which segments deserve a zoom-in to add energy and emphasis. Zoom the HOOK / opening line, the key claims and reveals, emphatic or high-energy delivery, punchlines, numbers / results, and the call to action. Do NOT zoom filler, transitions, list-continuations, or low-energy connective lines.

RULES:
- Zoom AT MOST about 40% of the segments. A few well-chosen zooms look far better than many.
- NEVER zoom two adjacent segments in a row — vary it so the video breathes.
- Prefer segments at least ~1.2s long.
- For each chosen segment return:
  - "i": the segment index (from the input)
  - "level": zoom factor between 1.06 and 1.18 (bigger = more emphatic)
  - "style": "in" for a smooth push-in (default), or "hold" for a static punch on a very short punchy line.

OUTPUT valid JSON ONLY — no prose, no markdown, no explanation:
{ "zooms": [ { "i": 0, "level": 1.12, "style": "in" } ] }

If nothing warrants a zoom, return { "zooms": [] }.`

function extractJson(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  t = t.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const m = t.match(/\{[\s\S]*\}/)
  return (m ? m[0] : t).trim()
}

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return !!data.user
}

function apiKey(): string {
  return Deno.env.get('AUTOZOOM_KEY') ?? Deno.env.get('OPEN_ROUTER_KEY') ?? Deno.env.get('ULTRACUT_JUDGE_KEY') ?? ''
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf

  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)

    const { segments, model: requestedModel } = await req
      .json()
      .catch(() => ({ segments: null, model: null }))

    if (typeof segments !== 'string' || !segments) return json({ error: 'missing segments' }, 400)

    const key = apiKey()
    if (!key) return json({ raw: null, judge: 'none' })

    const model = resolveModel(requestedModel)
    const tag = `autozoom:${model}`

    const body = {
      model,
      stream: false,
      // Gemma is not a reasoning model; keep it terse + deterministic.
      temperature: 0.3,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: segments }
      ]
    }

    let r: Response
    try {
      r = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'HTTP-Referer': 'https://easecutpro.com',
          'X-Title': 'EaseCutPro Auto Zoom'
        },
        body: JSON.stringify(body)
      })
    } catch {
      return json({ raw: null, judge: tag })
    }

    if (!r.ok) return json({ raw: null, judge: tag })

    let content = ''
    try {
      const data = (await r.json()) as { choices?: { message?: { content?: string } }[] }
      content = data.choices?.[0]?.message?.content ?? ''
    } catch {
      /* non-JSON body */
    }

    const cleaned = extractJson(content)
    return json({ raw: cleaned.length ? cleaned : null, judge: tag })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
