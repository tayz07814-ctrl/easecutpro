// EaseCutPro — MOMENT vision edge function. When a creator points at / shows
// something on camera ("this is not acne" over an armpit, then legs, then chest),
// the transcript is identical — the differentiator is the FRAME. Given a video
// frame + the spoken line, this returns a SHORT on-screen label of what's shown
// ("Armpit"). The app auto-places it as a text overlay (accepted via Suggest).
//
// Input:  { image: <base64 frame>, mediaType, line: <spoken sentence> }
// Output: { label: string }   (empty when nothing specific is shown / on error)
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

const SYSTEM = `You caption what a video creator is SHOWING on camera. Given a frame and the line they speak, reply with a SHORT on-screen label (1-3 words, Title Case) naming the thing being shown/pointed at — e.g. "Armpit", "Left Leg", "Product Label". If nothing specific is being shown, reply with an empty string. No punctuation, no sentence, just the label.`

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
    const line = String(body?.line ?? '').slice(0, 300)
    const mt = String(body?.mediaType ?? 'image/jpeg')
    const mediaType = /^image\/(png|jpeg|gif|webp)$/.test(mt) ? mt : 'image/jpeg'
    if (!image) return json({ label: '' })

    const key = Deno.env.get('ANTHROPIC_API_KEY')
    if (!key) return json({ label: '' })
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: 60,
          system: SYSTEM,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
              { type: 'text', text: `They say: "${line}". What are they showing? Give the short label.` }
            ]
          }]
        })
      })
      if (!r.ok) { console.warn('[moment-vision] anthropic HTTP', r.status); return json({ label: '' }) }
      const d = (await r.json()) as { content: { type: string; text?: string }[] }
      const label = d.content.map((b) => b.text ?? '').join('').trim().replace(/^["']|["'.]+$/g, '').slice(0, 40)
      return json({ label })
    } catch (e) {
      console.warn('[moment-vision] failed:', (e as Error).message)
      return json({ label: '' })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
