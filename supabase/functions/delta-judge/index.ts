// EaseCutPro — Retake δ (Delta) cloud judge edge function.
//
// The finalizer is the creator's OWN model over an OpenAI-compatible API
// (OpenRouter). Retake β (procut-judge / Claude Opus) is left UNTOUCHED; only the
// Retake δ button calls this, so production is unaffected.
//
// MODEL / LATENCY / QUALITY — the whole "press δ → cuts" flow must stay ~40s incl.
// ~23s transcription, so the judge has ~15s, and Supabase's edge wall-clock hard
// limit is 150s. Benchmarked head-to-head on a real transcript:
//   • deepseek-v4-pro   — reasons ~172s → HTTP 546 (killed) → no cuts. Too slow.
//   • deepseek-v4-flash — reasoning ON explodes to ~4.5k tokens / 55-88s (over
//                         budget); reasoning OFF is fast (~2s) but UNRELIABLE
//                         (misses cuts or over-cuts run-to-run).
//   • google/gemini-3.5-flash — reasons ~4x more efficiently: ~1-1.6k tokens in
//                         ~7s, and RELIABLY emits clean whole-take span cuts.
// Default is now z-ai/glm-5.2 (creator's choice). GLM 5.2 is a large-scale
// REASONING model, so watch the latency budget: effort=low + throughput routing
// keep it as fast as possible, but if runs get slow / fall back to β, set
// DELTA_REASONING_EFFORT=off. Any model still works via DELTA_MODEL
// (e.g. google/gemini-3.5-flash or qwen/qwen3.7-plus for a lighter/cheaper judge).
//
// The SYSTEM prompt forces WHOLE-TAKE SPAN cuts (not scattered word/filler removal),
// which is what makes a fast model produce pro-quality edits.
//
// Same request/response shape as procut-judge; raw:null on any failure so the cut
// job always completes.
//
// Config:
//   DELTA_JUDGE_KEY  — required. OpenRouter sk-or-… key. Edge secret OR Supabase
//                      Vault via the service-role-only delta_judge_key() RPC.
//   DELTA_BASE_URL   — optional. Default https://openrouter.ai/api/v1.
//   DELTA_MODEL      — optional. Default z-ai/glm-5.2.
//   DELTA_REASONING_EFFORT      — optional. low|medium|high|off. Default low.
//   DELTA_REASONING_MAX_TOKENS  — optional alt cap (effort wins if both set).
//   DELTA_PROVIDER_SORT         — optional. throughput|latency|price|off. Default throughput.

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

const BASE_URL = Deno.env.get('DELTA_BASE_URL') ?? 'https://openrouter.ai/api/v1'
const MODEL = Deno.env.get('DELTA_MODEL') ?? 'z-ai/glm-5.2'

// Reasoning control. Default effort=low — GLM 5.2 is a reasoning model, so keep
// the thinking budget SMALL to stay inside the ~15s judge budget. If runs get
// slow (or fall back to β), set DELTA_REASONING_EFFORT=off; bump to medium/high
// only if cut quality needs it and you can afford the latency.
function reasoningConfig(): Record<string, unknown> {
  const effort = Deno.env.get('DELTA_REASONING_EFFORT')?.toLowerCase()
  if (effort === 'off') return { enabled: false }
  if (effort === 'low' || effort === 'medium' || effort === 'high') return { effort }
  const raw = Deno.env.get('DELTA_REASONING_MAX_TOKENS')
  if (raw !== undefined && raw !== '') {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n)) return n > 0 ? { max_tokens: n } : { enabled: false }
  }
  return { effort: 'low' }
}

// Provider routing. Default: route to the highest-throughput provider (fastest
// tokens). `off` lets OpenRouter pick its default.
function providerConfig(): Record<string, unknown> | undefined {
  const sort = Deno.env.get('DELTA_PROVIDER_SORT')?.toLowerCase()
  if (sort === 'off') return undefined
  if (sort === 'throughput' || sort === 'latency' || sort === 'price') return { sort }
  return { sort: 'throughput' }
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

// The key is NEVER hardcoded. Prefer an edge secret (DELTA_JUDGE_KEY); otherwise
// read it from the Supabase Vault via the service-role-only delta_judge_key() RPC.
async function getApiKey(): Promise<string> {
  const env = Deno.env.get('DELTA_JUDGE_KEY')
  if (env) return env
  try {
    const { data } = await admin().rpc('delta_judge_key')
    if (typeof data === 'string' && data) return data
  } catch {
    /* vault not configured */
  }
  return ''
}

// Pull the JSON EDL out of a model reply: drop <think> reasoning and ```fences```,
// then keep the outermost {...} object.
function extractEdl(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  t = t.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const m = t.match(/\{[\s\S]*\}/)
  return (m ? m[0] : t).trim()
}

// Whole-take-span prompt — the key to pro-quality cuts from a fast model. Forces
// contiguous span cuts of entire earlier takes, never scattered word/filler removal.
const SYSTEM = `You are a video RETAKE editor. The speaker recorded the same lines MULTIPLE times — false starts, restarts, repeated/aborted takes. Delete EVERY earlier/aborted attempt so only the final clean take of each line remains and the kept words read as one smooth script.

SCAN THE WHOLE TRANSCRIPT from index 0 to the last index, IN ORDER. A real recording usually has SEVERAL fix points — find them ALL, do not stop after the first. Two kinds:

1) SHORT false-starts / stutters: 1-4 words abandoned and immediately re-started — e.g. "this is— this," then "this is probably…" (cut the abandoned "this is— this,"); "I'm," then "I'm glad…" (cut "I'm,"). Small, but you MUST catch every one.
2) LONG repeated-take tangles: the same sentence attempted several times with restarts before a final clean version — cut the WHOLE messy run of attempts as ONE span, keeping only the final complete take.

RULES:
- For EACH group of attempts, emit ONE contiguous word_cut from the first word of the earliest attempt to the last word right before the final good take begins. Prefer wide spans; to should be greater than from except for a lone stutter word.
- NEVER scatter single-word cuts across a take (do NOT delete "literally"/"like"/"which" one-by-one). Cut the whole earlier take as one span; leave the surviving take VERBATIM.
- Keep the LAST take in time. Never trim/split/reword the surviving take.
- Never delete filler/"um"/"like" inside the ONLY take of a line. Said once = keep 100%.
- Never cut non-repeated content, intros, or outros.

PAUSES: leave them alone unless one is dead air exactly at a cut boundary you created; then you may shorten it (keep_ms).

Return VALID JSON ONLY (no prose, no markdown fences), exactly:
{"word_cuts":[{"from":11,"to":25,"reason":"earlier aborted takes; kept the final take"}],"pause_cuts":[{"pause_id":"p3","keep_ms":150,"reason":"dead air at a cut"}]}
word_cuts use INCLUSIVE word indices. pause_cuts reference pause ids; keep_ms=0 removes the pause. If the first-pass EDL is empty, do the full analysis yourself.`

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return !!data.user
}

async function finalize(apiKey: string, payload: string, proposal: unknown): Promise<string> {
  const userText =
    `${payload}\nFIRST-PASS PROPOSED EDL:\n${JSON.stringify(proposal)}\n\nVerify it, guarantee ZERO repeats remain (keep the LAST take of every duplicate), keep the kept script coherent, and return the final EDL.`
  const provider = providerConfig()
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 16000,
    stream: false,
    reasoning: reasoningConfig(),
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userText }
    ]
  }
  if (provider) body.provider = provider
  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://easecutpro.com',
      'X-Title': 'EaseCutPro Retake delta'
    },
    body: JSON.stringify(body)
  })
  const bodyText = await r.text()
  let content = ''
  if (r.ok) {
    try {
      content = (JSON.parse(bodyText) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? ''
    } catch {
      /* non-JSON body */
    }
  }
  const cleaned = extractEdl(content)

  // DIAGNOSTIC (temporary): confirm the first real run post-fix. Removed in cleanup.
  try {
    await admin().rpc('log_delta_debug', {
      payload: {
        model: MODEL,
        http_status: r.status,
        ok: r.ok,
        content_len: content.length,
        cleaned_len: cleaned.length,
        content_snippet: content.slice(0, 3000),
        err_body: r.ok ? null : bodyText.slice(0, 2000),
        raw_body: bodyText.slice(0, 8000),
        req_payload: payload.slice(0, 16000)
      }
    })
  } catch {
    /* never let the diagnostic break the run */
  }

  if (!r.ok) throw new Error(`model API: HTTP ${r.status} ${bodyText.slice(0, 200)}`)
  return cleaned
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const { payload, proposal } = await req.json().catch(() => ({ payload: null, proposal: null }))
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)

    const apiKey = await getApiKey()
    if (!apiKey) return json({ raw: null, judge: 'none' })
    try {
      return json({ raw: await finalize(apiKey, payload, proposal ?? { word_cuts: [], pause_cuts: [] }), judge: `delta:${MODEL}` })
    } catch (e) {
      console.warn('[delta-judge] model API failed:', (e as Error).message)
      return json({ raw: null, judge: `delta:${MODEL}` })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
