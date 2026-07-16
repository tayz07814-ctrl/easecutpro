// EaseCutPro — overlay VISION edge function (v1.5). Describes what an overlay
// image DEPICTS in one short phrase, so matching/suggestion can key on the card's
// content (a "50% OFF" badge) not just its filename. Called once per overlay and
// cached client-side. Returns { description: '' } on any problem so callers fall
// back to the overlay name.
//
// Input:  { image: <base64>, mediaType: 'image/png'|'image/jpeg'|'image/gif'|'image/webp' }
// Output: { description: string }
//
// Reuses the ANTHROPIC_API_KEY secret. Claude Opus is multimodal.

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

const SYSTEM = `You label overlay graphics for a video editor. Describe what the image DEPICTS in ONE short phrase a matcher can use — the visible text, product, or subject (e.g. "a red '50% OFF' discount badge", "a smiling before/after skincare photo"). No preamble, just the phrase.`

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return !!data.user
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

    const key = Deno.env.get('ANTHROPIC_API_KEY')
    if (!key) return json({ description: '' })
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
      if (!r.ok) { console.warn('[overlay-vision] anthropic HTTP', r.status); return json({ description: '' }) }
      const d = (await r.json()) as { content: { type: string; text?: string }[] }
      const description = d.content.map((b) => b.text ?? '').join('').trim().slice(0, 200)
      return json({ description })
    } catch (e) {
      console.warn('[overlay-vision] failed:', (e as Error).message)
      return json({ description: '' })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
