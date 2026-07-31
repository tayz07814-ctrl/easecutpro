// EaseCutPro — overlay VISION edge function (v2). Describes what an overlay / b-roll
// image DEPICTS in one short phrase, so Auto B-roll matching keys on the card's
// CONTENT (a "50% OFF" badge, a stomach diagram) not just its filename. Called once
// per overlay and cached client-side. Returns { description: '' } on any problem so
// callers fall back to the overlay name.
//
// Input:  { image: <base64>, mediaType: 'image/png'|'image/jpeg'|'image/gif'|'image/webp' }
// Output: { description: string }
//
// VISION MODEL: Gemma on OpenRouter FIRST (google/gemma-3-27b-it is multimodal) —
// this is the "Gemma sees your images" path the Auto B-roll UI promises — then
// Anthropic Claude Opus as a fallback if the OpenRouter key/model is unavailable.
// Both keys live ONLY in edge-function secrets.

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

const SYSTEM = `You label overlay / b-roll graphics for a video editor. Describe what the image DEPICTS in ONE short phrase a matcher can use — the visible text, product, or subject (e.g. "a red '50% OFF' discount badge", "a smiling before/after skincare photo", "a diagram of a bloated stomach"). No preamble, just the phrase.`

const GEMMA_VISION = 'google/gemma-3-27b-it'

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return !!data.user
}

/** Gemma via OpenRouter (OpenAI-compatible, multimodal). '' on any problem. */
async function gemmaDescribe(image: string, mediaType: string): Promise<string> {
  const key = Deno.env.get('OPEN_ROUTER_KEY') ?? Deno.env.get('ULTRACUT_JUDGE_KEY') ?? Deno.env.get('AUTOZOOM_KEY')
  if (!key) return ''
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: GEMMA_VISION,
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this overlay in one short phrase.' },
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${image}` } }
            ]
          }
        ]
      })
    })
    if (!r.ok) { console.warn('[overlay-vision] gemma HTTP', r.status); return '' }
    const d = (await r.json()) as { choices?: { message?: { content?: string } }[] }
    return (d.choices?.[0]?.message?.content ?? '').trim().slice(0, 200)
  } catch (e) {
    console.warn('[overlay-vision] gemma failed:', (e as Error).message)
    return ''
  }
}

/** Anthropic Claude Opus fallback (multimodal). '' on any problem. */
async function claudeDescribe(image: string, mediaType: string): Promise<string> {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  if (!key) return ''
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 200,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: 'Describe this overlay in one short phrase.' }
          ]
        }]
      })
    })
    if (!r.ok) { console.warn('[overlay-vision] anthropic HTTP', r.status); return '' }
    const d = (await r.json()) as { content: { type: string; text?: string }[] }
    return d.content.map((b) => b.text ?? '').join('').trim().slice(0, 200)
  } catch (e) {
    console.warn('[overlay-vision] anthropic failed:', (e as Error).message)
    return ''
  }
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const body = await req.json().catch(() => ({}))
    const image = String(body?.image ?? '')
    const mt = String(body?.mediaType ?? 'image/png')
    const mediaType = /^image\/(png|jpeg|gif|webp)$/.test(mt) ? mt : 'image/png'
    if (!image) return json({ description: '' })

    // Gemma sees the image first; Claude backs it up if OpenRouter is unavailable.
    let via: 'gemma-openrouter' | 'claude-anthropic' | 'none' = 'gemma-openrouter'
    let description = await gemmaDescribe(image, mediaType)
    if (!description) {
      via = 'claude-anthropic'
      description = await claudeDescribe(image, mediaType)
    }
    if (!description) via = 'none'
    // Attribution: shows in the edge-function logs so a run's actual vision
    // provider (Gemma via OpenRouter vs the Claude fallback) is verifiable.
    console.log(`[overlay-vision] via=${via} len=${description.length}`)
    return json({ description, via })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
