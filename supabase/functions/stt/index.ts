// EaseCutPro — STT edge function (verbatim transcription for Retake β and the
// Transcribe button in the cloud build).
//
// The browser extracts the AUDIO locally (video never leaves the device),
// uploads it to the private stt-audio bucket via a signed URL, and this
// function drives AssemblyAI (primary) / Deepgram (fallback) from short-lived
// signed download URLs. Request/response contracts mirror src/shared/cloud.ts;
// provider params mirror src/main/retakeaware/providers.ts (disfluencies
// preserved, smart_format off — verbatim or the retake analysis is blind).
//
// Secrets (supabase secrets set): ASSEMBLYAI_API_KEY, DEEPGRAM_API_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'

// Inlined from _shared/http.ts so this function deploys as a single file.
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

const BUCKET = 'stt-audio'

function serviceClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

async function requireUser(req: Request): Promise<{ id: string } | null> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return data.user ? { id: data.user.id } : null
}

/** A storage path is only ever touchable by its owner (uid prefix). */
function ownPath(path: unknown, uid: string): string {
  const p = String(path ?? '')
  if (!p.startsWith(`${uid}/`) || p.includes('..')) throw new Error('invalid path')
  return p
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    const user = await requireUser(req)
    if (!user) return json({ error: 'Not signed in' }, 401)
    const body = await req.json().catch(() => ({}))
    const service = serviceClient()

    switch (body.action) {
      case 'status':
        return json({
          assemblyai: !!Deno.env.get('ASSEMBLYAI_API_KEY'),
          deepgram: !!Deno.env.get('DEEPGRAM_API_KEY')
        })

      case 'sign-upload': {
        // Per-plan AI-minute gate (per billing cycle): charge this run's audio
        // seconds against the user's plan cap. Fail-OPEN on any metering error so
        // a hiccup never blocks the product; only bites subscribers over their cap
        // (no-subscription users are unlimited).
        const seconds = Math.max(0, Math.floor(Number(body.seconds) || 0))
        const gate = await service.rpc('consume_ai_seconds', { p_user: user.id, p_seconds: seconds })
        const g = gate.data as { allowed?: boolean } | null
        if (!gate.error && g && g.allowed === false) return json({ error: 'minute_limit' }, 402)

        const ext = (String(body.ext || 'wav').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'wav').toLowerCase()
        const path = `${user.id}/${crypto.randomUUID()}.${ext}`
        const { data, error } = await service.storage.from(BUCKET).createSignedUploadUrl(path)
        if (error) return json({ error: `sign-upload: ${error.message}` }, 500)
        return json({ path, token: data.token })
      }

      case 'aai-start': {
        const key = Deno.env.get('ASSEMBLYAI_API_KEY')
        if (!key) return json({ error: 'AssemblyAI is not configured on the server' }, 400)
        const path = ownPath(body.path, user.id)
        const { data: signed, error } = await service.storage.from(BUCKET).createSignedUrl(path, 3600)
        if (error || !signed) return json({ error: `audio not found: ${error?.message ?? path}` }, 404)
        const r = await fetch('https://api.assemblyai.com/v2/transcript', {
          method: 'POST',
          headers: { authorization: key, 'content-type': 'application/json' },
          body: JSON.stringify({
            audio_url: signed.signedUrl,
            // verbatim/disfluency-preserving — same params as the PC engine
            disfluencies: true,
            format_text: false,
            punctuate: true,
            // Diarization: tag each word/utterance with a speaker label (A, B, …)
            // so the retake judge knows up front whether it's one speaker or a
            // talent + off-camera crew (the crew turns are production chatter).
            speaker_labels: true,
            // must be the speech_models ARRAY (singular param 400s)
            speech_models: ['universal-3-5-pro', 'universal-2']
          })
        })
        if (!r.ok) return json({ error: `AssemblyAI start: HTTP ${r.status} ${(await r.text()).slice(0, 200)}` }, 502)
        const { id } = (await r.json()) as { id: string }
        return json({ id })
      }

      case 'aai-poll': {
        const key = Deno.env.get('ASSEMBLYAI_API_KEY')
        if (!key) return json({ error: 'AssemblyAI is not configured on the server' }, 400)
        const id = String(body.id ?? '')
        if (!/^[\w-]+$/.test(id)) return json({ error: 'invalid id' }, 400)
        const r = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers: { authorization: key } })
        if (!r.ok) return json({ error: `AssemblyAI poll: HTTP ${r.status}` }, 502)
        const t = (await r.json()) as {
          status: string
          error?: string
          words?: { text: string; start: number; end: number; confidence?: number; speaker?: string }[]
          utterances?: { start: number; end: number; text: string; speaker?: string }[]
        }
        return json({
          status: t.status,
          error: t.error,
          // speaker: AssemblyAI's diarization label (A, B, …) when speaker_labels
          // is on; undefined on mono / pre-diarization jobs.
          words: t.words?.map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: w.confidence, speaker: w.speaker })),
          utterances: t.utterances?.map((u) => ({ start: u.start, end: u.end, text: u.text, speaker: u.speaker }))
        })
      }

      case 'deepgram': {
        const key = Deno.env.get('DEEPGRAM_API_KEY')
        if (!key) return json({ error: 'Deepgram is not configured on the server' }, 400)
        const path = ownPath(body.path, user.id)
        const { data: signed, error } = await service.storage.from(BUCKET).createSignedUrl(path, 3600)
        if (error || !signed) return json({ error: `audio not found: ${error?.message ?? path}` }, 404)
        // smart_format stays OFF: it can normalize away the disfluencies we need.
        // diarize=true tags each word with a speaker number (parity with AAI).
        const qs = 'model=nova-3&punctuate=true&filler_words=true&utterances=true&smart_format=false&diarize=true'
        const r = await fetch(`https://api.deepgram.com/v1/listen?${qs}`, {
          method: 'POST',
          headers: { Authorization: `Token ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ url: signed.signedUrl })
        })
        if (!r.ok) return json({ error: `Deepgram: HTTP ${r.status} ${(await r.text()).slice(0, 200)}` }, 502)
        const j = (await r.json()) as {
          results?: {
            channels?: { alternatives?: { words?: { word: string; punctuated_word?: string; start: number; end: number; confidence?: number; speaker?: number }[] }[] }[]
            utterances?: { start: number; end: number; transcript: string; speaker?: number }[]
          }
        }
        return json({
          words: j.results?.channels?.[0]?.alternatives?.[0]?.words ?? [],
          utterances: (j.results?.utterances ?? []).map((u) => ({ start: u.start, end: u.end, transcript: u.transcript, speaker: u.speaker }))
        })
      }

      case 'cleanup': {
        const path = ownPath(body.path, user.id)
        await service.storage.from(BUCKET).remove([path])
        return json({ ok: true })
      }

      default:
        return json({ error: `unknown action: ${String(body.action)}` }, 400)
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
