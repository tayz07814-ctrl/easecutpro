// EaseCutPro — MOMENT vision edge function (image-to-image overlay matching).
// When a creator SHOWS something on camera ("this is not acne" over an armpit,
// then legs, then chest), the transcript is identical — the differentiator is the
// FRAME. Given the video frame + the creator's own overlay thumbnails, this picks
// which overlay depicts what's being shown, so the app can place THAT overlay
// image (not an invented text label).
//
// Input:  { frame: <base64>, frameMediaType, line, overlays: [{ id, name, image, mediaType }] }
// Output: { overlayId: string }   ('' when nothing matches / on error)
//
// The model sees the frame first, then each overlay tagged by a LETTER (opaque ids
// are never sent to it), and replies with just the letter; we map it back to an id.
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

const SYSTEM =
  'You match what a video creator is SHOWING on camera to their overlay graphics. ' +
  'The FIRST image is a frame from the video. Each following image is one of the ' +
  "creator's overlay assets, tagged by a letter. Decide which ONE overlay depicts the " +
  'SAME thing shown or pointed to in the video frame (same body part, product, or ' +
  'subject). Reply with ONLY that letter. If none clearly matches, reply "none". ' +
  'Reply with a single token — a letter or "none".'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const okType = (t: string): boolean => /^image\/(png|jpeg|gif|webp)$/.test(t)

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return !!data.user
}

interface Thumb { id: string; name: string; image: string; mediaType: string }

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const body = await req.json().catch(() => ({}))
    const frame = String(body?.frame ?? '')
    const line = String(body?.line ?? '').slice(0, 300)
    const frameType = okType(String(body?.frameMediaType ?? '')) ? String(body.frameMediaType) : 'image/jpeg'
    const overlaysIn: Thumb[] = Array.isArray(body?.overlays) ? body.overlays : []
    const pool = overlaysIn.filter((o) => o && typeof o.image === 'string' && o.image).slice(0, 24)
    if (!frame || !pool.length) return json({ overlayId: '' })

    const key = Deno.env.get('ANTHROPIC_API_KEY')
    if (!key) return json({ overlayId: '' })
    try {
      const content: Array<Record<string, unknown>> = [
        { type: 'text', text: `Video frame (the creator says: "${line}"):` },
        { type: 'image', source: { type: 'base64', media_type: frameType, data: frame } }
      ]
      pool.forEach((o, i) => {
        content.push({ type: 'text', text: `Overlay ${LETTERS[i]} — ${String(o.name || 'untitled').slice(0, 60)}:` })
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: okType(o.mediaType) ? o.mediaType : 'image/jpeg', data: o.image }
        })
      })
      content.push({
        type: 'text',
        text: 'Which overlay letter depicts what is shown in the video frame? Reply with the letter only, or "none".'
      })
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 8, system: SYSTEM, messages: [{ role: 'user', content }] })
      })
      if (!r.ok) { console.warn('[moment-vision] anthropic HTTP', r.status); return json({ overlayId: '' }) }
      const d = (await r.json()) as { content: { type: string; text?: string }[] }
      const text = d.content.map((b) => b.text ?? '').join('').trim()
      const m = text.match(/[A-Za-z]/)
      if (!m || /^none/i.test(text)) return json({ overlayId: '' })
      const idx = LETTERS.indexOf(m[0].toUpperCase())
      return json({ overlayId: idx >= 0 && idx < pool.length ? pool[idx].id : '' })
    } catch (e) {
      console.warn('[moment-vision] failed:', (e as Error).message)
      return json({ overlayId: '' })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
