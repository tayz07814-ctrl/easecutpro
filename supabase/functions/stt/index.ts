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

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { json, preflight } from '../_shared/http.ts'
import {
  chargeSttSeconds,
  readBody,
  requireUser,
  serviceClient,
  wavSecondsFromUrl
} from '../_shared/gate.ts'

const BUCKET = 'stt-audio'

/** Charge this run's audio against the caller's AI-minute allowance.
 *
 *  Called from the endpoints that actually spend provider money (aai-start,
 *  deepgram) rather than from sign-upload, because nothing forces a caller
 *  through sign-upload: with a path it already holds it can hit aai-start
 *  directly, which is exactly how the old gate was bypassed.
 *
 *  The length comes from the stored object's own WAV header — never from the
 *  request body, which used to supply both `seconds` and `freeMin`. */
async function meterAudio(
  service: SupabaseClient,
  userId: string,
  signedUrl: string
): Promise<{ ok: true } | { ok: false; res: Response }> {
  const seconds = await wavSecondsFromUrl(signedUrl)
  if (seconds === null) return { ok: false, res: json({ error: 'unreadable audio' }, 400) }
  return await chargeSttSeconds(service, userId, seconds)
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
    const userId = await requireUser(req)
    if (!userId) return json({ error: 'Not signed in' }, 401)
    const body = await readBody(req, 100_000).catch(() => null)
    if (!body) return json({ error: 'payload_too_large' }, 413)
    const service = serviceClient()

    switch (body.action) {
      case 'status':
        return json({
          assemblyai: !!Deno.env.get('ASSEMBLYAI_API_KEY'),
          deepgram: !!Deno.env.get('DEEPGRAM_API_KEY')
        })

      case 'sign-upload': {
        // No metering here. Handing out an upload URL costs nothing, and the
        // caller's `seconds`/`freeMin` were never trustworthy anyway — the charge
        // now happens at aai-start/deepgram against the object's real length.
        //
        // The extension is pinned to wav: it is the only thing the app uploads
        // (src/renderer/src/cloud/audio.ts) and the only container the meter can
        // measure, so anything else would be billable-but-unmeasurable.
        const path = `${userId}/${crypto.randomUUID()}.wav`
        const { data, error } = await service.storage.from(BUCKET).createSignedUploadUrl(path)
        if (error) return json({ error: `sign-upload: ${error.message}` }, 500)
        return json({ path, token: data.token })
      }

      case 'aai-start': {
        const key = Deno.env.get('ASSEMBLYAI_API_KEY')
        if (!key) return json({ error: 'AssemblyAI is not configured on the server' }, 400)
        const path = ownPath(body.path, userId)
        const { data: signed, error } = await service.storage.from(BUCKET).createSignedUrl(path, 3600)
        if (error || !signed) return json({ error: `audio not found: ${error?.message ?? path}` }, 404)

        // This is the call that spends money, so this is where it gets charged.
        const gate = await meterAudio(service, userId, signed.signedUrl)
        if (!gate.ok) return gate.res

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
        const path = ownPath(body.path, userId)
        const { data: signed, error } = await service.storage.from(BUCKET).createSignedUrl(path, 3600)
        if (error || !signed) return json({ error: `audio not found: ${error?.message ?? path}` }, 404)

        // Deepgram is the fallback provider but costs the same as the primary,
        // so it is metered identically.
        const gate = await meterAudio(service, userId, signed.signedUrl)
        if (!gate.ok) return gate.res

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
        const path = ownPath(body.path, userId)
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
