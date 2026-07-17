// EaseCutPro — MOMENT vision edge function (image-to-image overlay matching).
// When a creator SHOWS something on camera ("this is not acne" over an armpit,
// then legs, then chest), the transcript is identical — the differentiator is the
// FRAME. Given a few frames across the moment + the creator's own overlay thumbnails,
// this picks which overlay depicts what's being shown, so the app can place THAT
// overlay image (not an invented text label).
//
// Input:  { frames: [{ image, mediaType }], line, overlays: [{ id, name, image, mediaType }] }
// Output: { overlayId: string, note?: string }   (overlayId '' when nothing matches / on
//         error; note = the body part / thing the model identified, for the run log)
//
// The model sees the frames first (several sampled across the moment so the reveal is
// caught wherever it lands), then each overlay tagged by a LETTER (opaque ids are never
// sent to it). It reasons ("<what they show> => <LETTER>"); we parse the letter -> id.
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
  'You match what a video creator SHOWS on camera to their overlay graphics. The FIRST ' +
  'images are frames sampled across ONE moment of the video. Each later image is one of ' +
  "the creator's overlay assets, tagged by a LETTER and a NAME — the NAMES (often body " +
  'parts) are the main discriminator. Work in two steps:\n' +
  '1) Identify the SPECIFIC body part or thing the creator is showing/pointing to across ' +
  'the frames (e.g. "left armpit", "legs", "chest", "hand"). If they are only talking and ' +
  'not clearly showing a specific part, there is NO match.\n' +
  '2) Choose the overlay whose NAME matches that thing. Different body parts MUST map to ' +
  'different overlays — never default to one.\n' +
  'Reply on ONE line exactly as: <what they show> => <LETTER>   (or "<what you see> => none" ' +
  'if nothing matches).'

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
interface Frame { image: string; mediaType: string }

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const body = await req.json().catch(() => ({}))
    const line = String(body?.line ?? '').slice(0, 300)
    const framesIn: Frame[] = Array.isArray(body?.frames) ? body.frames : []
    const framePool = framesIn.filter((f) => f && typeof f.image === 'string' && f.image).slice(0, 3)
    const overlaysIn: Thumb[] = Array.isArray(body?.overlays) ? body.overlays : []
    const pool = overlaysIn.filter((o) => o && typeof o.image === 'string' && o.image).slice(0, 24)
    if (!framePool.length || !pool.length) return json({ overlayId: '' })

    const key = Deno.env.get('ANTHROPIC_API_KEY')
    if (!key) return json({ overlayId: '' })
    try {
      const content: Array<Record<string, unknown>> = [
        { type: 'text', text: `Video frames across the moment (the creator says: "${line}"):` }
      ]
      framePool.forEach((f) => {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: okType(f.mediaType) ? f.mediaType : 'image/jpeg', data: f.image }
        })
      })
      pool.forEach((o, i) => {
        content.push({ type: 'text', text: `Overlay ${LETTERS[i]} — ${String(o.name || 'untitled').slice(0, 60)}:` })
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: okType(o.mediaType) ? o.mediaType : 'image/jpeg', data: o.image }
        })
      })
      content.push({
        type: 'text',
        text: 'Identify what the creator shows across the frames, then give the matching overlay. Reply as: <what they show> => <LETTER> (or "... => none").'
      })
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 120, system: SYSTEM, messages: [{ role: 'user', content }] })
      })
      if (!r.ok) { console.warn('[moment-vision] anthropic HTTP', r.status); return json({ overlayId: '' }) }
      const d = (await r.json()) as { content: { type: string; text?: string }[] }
      const text = d.content.map((b) => b.text ?? '').join('').trim()
      // Expected "<phrase> => <LETTER|none>". Parse the token after the last "=>";
      // fall back to the whole reply. `note` (the identified thing) is returned for logs.
      const arrow = text.lastIndexOf('=>')
      const note = (arrow >= 0 ? text.slice(0, arrow) : text).trim().replace(/\s+/g, ' ').slice(0, 60)
      const tail = arrow >= 0 ? text.slice(arrow + 2).trim() : text
      let overlayId = ''
      if (!/\bnone\b/i.test(tail)) {
        const lm = tail.match(/[A-Za-z]/)
        if (lm) { const idx = LETTERS.indexOf(lm[0].toUpperCase()); if (idx >= 0 && idx < pool.length) overlayId = pool[idx].id }
      }
      return json({ overlayId, note })
    } catch (e) {
      console.warn('[moment-vision] failed:', (e as Error).message)
      return json({ overlayId: '' })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
