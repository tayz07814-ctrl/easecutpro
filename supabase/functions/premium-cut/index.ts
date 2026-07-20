// EaseCutPro - Premium Cut cloud edge function.
//
// A THIRD, EXPERIMENTAL cut engine beside Retake Beta (procut-judge, Opus) and
// Ultracut (ultracut-judge, DeepSeek). Unlike those two it does NOT take a text
// transcript: the browser uploads the extracted 16 kHz mono WAV to the stt-audio
// bucket (the SAME sign-upload flow STT uses) and passes the object { path }. This
// function reads the WAV server-side, base64-encodes it, and sends it as ONE
// `input_audio` message to Gemini 3.5 Flash over OpenRouter. Gemini LISTENS: it
// transcribes AND proposes cuts (retakes + silence) in a single pass. There is no
// STT and no ONNX VAD in this engine - everything is Gemini's judgment.
//
// Returns { raw, judge } (same shape as procut-judge/ultracut-judge) where `raw`
// is Gemini's JSON string { transcript, cuts, clean_transcript }; the browser
// parses + maps it. raw:null on any failure so the cut job always completes.
//
// Config:
//   OPEN_ROUTER_KEY / ULTRACUT_JUDGE_KEY - OpenRouter sk-or-... key (falls back to
//                     the Supabase Vault delta_judge_key() RPC).
//   PREMIUM_MODEL   - optional. Default google/gemini-3.5-flash.
//   PREMIUM_BASE_URL- optional. Default https://openrouter.ai/api/v1.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { encodeBase64 } from 'jsr:@std/encoding/base64'

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

const BASE_URL = Deno.env.get('PREMIUM_BASE_URL') ?? 'https://openrouter.ai/api/v1'
const MODEL = Deno.env.get('PREMIUM_MODEL') ?? 'google/gemini-3.5-flash'
const BUCKET = 'stt-audio'

// The creator's Premium prompt - a one-shot multimodal talking-head editor. Gemini
// hears the audio and returns the verbatim transcript, the minimum cut ranges, and
// the resulting clean transcript, all as JSON.
const PREMIUM_PROMPT = `You are a professional talking-head video editor.

Analyze the ENTIRE recording before responding.

Task:
1. Create a complete verbatim transcript with timestamps. Include EVERYTHING spoken, including mistakes, stutters, retakes, production chatter, and interruptions.
2. Then identify the MINIMUM timestamp ranges that should be removed to produce a clean, publish-ready recording.
3. Generate the final clean transcript after applying those cuts.

Remove:
- Silence
- Stutters
- False starts
- Sentence restarts
- Repeated words
- Retakes (keep only the best/final take)
- Production chatter
- Off-camera conversations
- Recording/mic/camera checks
- Background interruptions not intended for viewers

Keep:
- All meaningful content
- Natural pauses
- Emotion
- Storytelling

Return ONLY valid JSON:

{
  "transcript":[{"start":0.0,"end":0.0,"text":""}],
  "cuts":[{"start":0.0,"end":0.0,"reason":"","confidence":0.0}],
  "clean_transcript":""
}

Before responding, verify:
- Transcript contains EVERYTHING spoken.
- Clean transcript equals transcript after applying cuts.
- Cuts are the smallest possible ranges.
- No hallucinated timestamps or cuts.`

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

// The signed-in user (or null). Also used to scope the bucket path to its owner.
async function getUser(req: Request): Promise<{ id: string } | null> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return data.user ? { id: data.user.id } : null
}

// OpenRouter key. NEVER hardcoded. Prefer OPEN_ROUTER_KEY, then ULTRACUT_JUDGE_KEY,
// then the Supabase Vault delta_judge_key() RPC (same key the other judges use).
async function getApiKey(): Promise<string> {
  const env = Deno.env.get('OPEN_ROUTER_KEY') ?? Deno.env.get('ULTRACUT_JUDGE_KEY')
  if (env) return env
  try {
    const { data } = await admin().rpc('delta_judge_key')
    if (typeof data === 'string' && data) return data
  } catch {
    /* vault not configured */
  }
  return ''
}

// DIAGNOSTIC (temporary): mirror the other judges so a run is inspectable in
// delta_debug. Harmless (try/catch).
async function logDebug(fields: Record<string, unknown>): Promise<void> {
  try {
    await admin().rpc('log_delta_debug', { payload: { judge: 'premium', ...fields } })
  } catch {
    /* never let the diagnostic break the run */
  }
}

// Pull the JSON object out of a model reply: drop ```fences``` and any prose,
// then keep the outermost {...} object.
function extractJson(raw: string): string {
  const t = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const m = t.match(/\{[\s\S]*\}/)
  return (m ? m[0] : t).trim()
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    const user = await getUser(req)
    if (!user) return json({ error: 'Not signed in' }, 401)
    const { path } = await req.json().catch(() => ({ path: null }))
    if (typeof path !== 'string' || !path) return json({ error: 'missing path' }, 400)
    // scope to the caller's own objects (paths are `${uid}/uuid.wav`).
    if (!path.startsWith(`${user.id}/`)) return json({ error: 'forbidden' }, 403)

    // read the uploaded WAV server-side (service role) and base64 it.
    const dl = await admin().storage.from(BUCKET).download(path)
    if (dl.error || !dl.data) {
      await logDebug({ model: MODEL, http_status: 0, ok: false, err_body: `download: ${dl.error?.message ?? 'no data'}`, req_payload: path })
      return json({ raw: null, judge: 'premium' })
    }
    const bytes = new Uint8Array(await dl.data.arrayBuffer())
    const b64 = encodeBase64(bytes)

    const apiKey = await getApiKey()
    if (!apiKey) return json({ raw: null, judge: 'none' })

    const body = {
      model: MODEL,
      // Gemini returns the FULL verbatim transcript + the clean transcript, so give
      // the answer room. Audio itself is the bulk of the request.
      max_tokens: 16000,
      messages: [
        { role: 'system', content: PREMIUM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is the complete recording. Follow the instructions exactly and return ONLY the JSON.' },
            { type: 'input_audio', input_audio: { data: b64, format: 'wav' } }
          ]
        }
      ]
    }

    let r: Response
    try {
      r = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'HTTP-Referer': 'https://easecutpro.com',
          'X-Title': 'EaseCutPro Premium Cut'
        },
        body: JSON.stringify(body)
      })
    } catch (e) {
      await logDebug({ model: MODEL, http_status: 0, ok: false, err_body: (e as Error).message, req_payload: path, audio_bytes: bytes.length })
      return json({ raw: null, judge: 'premium' })
    }
    const bodyText = await r.text()
    let content = ''
    if (r.ok) {
      try {
        content = (JSON.parse(bodyText) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? ''
      } catch {
        /* non-JSON body */
      }
    }
    const cleaned = extractJson(content)
    await logDebug({
      model: MODEL,
      provider: 'openrouter',
      http_status: r.status,
      ok: r.ok,
      content_len: content.length,
      cleaned_len: cleaned.length,
      content_snippet: content.slice(0, 3000),
      err_body: r.ok ? null : bodyText.slice(0, 2000),
      raw_body: bodyText.slice(0, 8000),
      audio_bytes: bytes.length,
      req_payload: path
    })
    if (!r.ok || !cleaned) return json({ raw: null, judge: `premium:${MODEL}` })
    return json({ raw: cleaned, judge: `premium:${MODEL}` })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
