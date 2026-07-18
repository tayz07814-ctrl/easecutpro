// EaseCutPro — Ultracut (Beta) cloud judge edge function.
//
// A SEPARATE, EXPERIMENTAL twin of the retake judge that runs an OpenRouter test
// model (default z-ai/glm-5.2) over an OpenAI-compatible API. It exists ONLY so
// the easecut0.01 build can A/B "Ultracut Beta" (this, OpenRouter) against
// "Retake Beta" (procut-judge / delta-judge, Claude Opus on our official Anthropic
// key). NOTHING is shared with those functions — different function, different
// key, different provider. procut-judge / delta-judge are untouched, so production
// (which has no Ultracut button) never calls this and stays on Opus.
//
// Same request/response shape as procut-judge (payload, proposal → { raw, judge }),
// so the browser reuses the exact validateEdl/review pipeline. raw:null on any
// failure so the cut job always completes.
//
// Config:
//   ULTRACUT_JUDGE_KEY  — OpenRouter sk-or-… key. Falls back to DELTA_JUDGE_KEY
//                         (the existing OpenRouter secret) or the Supabase Vault
//                         via the service-role-only delta_judge_key() RPC.
//   ULTRACUT_BASE_URL   — optional. Default https://openrouter.ai/api/v1.
//   ULTRACUT_MODEL      — optional. Default z-ai/glm-5.2.
//   ULTRACUT_REASONING_EFFORT     — optional. low|medium|high|off. Default low.
//   ULTRACUT_REASONING_MAX_TOKENS — optional alt cap (effort wins if both set).
//   ULTRACUT_PROVIDER_SORT        — optional. throughput|latency|price|off. Default throughput.

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

const BASE_URL = Deno.env.get('ULTRACUT_BASE_URL') ?? 'https://openrouter.ai/api/v1'
const MODEL = Deno.env.get('ULTRACUT_MODEL') ?? 'z-ai/glm-5.2'

// Per-request model override (A/B testing a different OpenRouter model from the
// easecut0.01 build) — whitelisted so a signed-in user can't route to an
// arbitrary/expensive model. ULTRACUT_MODEL env still wins over the code default.
const MODEL_WHITELIST = new Set([
  'z-ai/glm-5.2',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.5-flash',
  'qwen/qwen3.7-plus'
])
function resolveModel(requested: unknown): string {
  return typeof requested === 'string' && MODEL_WHITELIST.has(requested) ? requested : MODEL
}

// Reasoning control. Default effort=low — enough to reliably find take boundaries
// while staying inside the ~15s judge budget. `off` disables (fast but unreliable).
function reasoningConfig(): Record<string, unknown> {
  const effort = Deno.env.get('ULTRACUT_REASONING_EFFORT')?.toLowerCase()
  if (effort === 'off') return { enabled: false }
  if (effort === 'low' || effort === 'medium' || effort === 'high') return { effort }
  const raw = Deno.env.get('ULTRACUT_REASONING_MAX_TOKENS')
  if (raw !== undefined && raw !== '') {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n)) return n > 0 ? { max_tokens: n } : { enabled: false }
  }
  return { effort: 'low' }
}

// Provider routing. Default: highest-throughput provider (fastest tokens).
function providerConfig(): Record<string, unknown> | undefined {
  const sort = Deno.env.get('ULTRACUT_PROVIDER_SORT')?.toLowerCase()
  if (sort === 'off') return undefined
  if (sort === 'throughput' || sort === 'latency' || sort === 'price') return { sort }
  return { sort: 'throughput' }
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

// OpenRouter key. NEVER hardcoded. Prefer ULTRACUT_JUDGE_KEY, then the existing
// DELTA_JUDGE_KEY OpenRouter secret, then the Supabase Vault delta_judge_key() RPC.
async function getApiKey(): Promise<string> {
  const env = Deno.env.get('ULTRACUT_JUDGE_KEY') ?? Deno.env.get('DELTA_JUDGE_KEY')
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

// DIAGNOSTIC (temporary): confirm the first real run. Harmless (try/catch).
async function logDebug(fields: Record<string, unknown>): Promise<void> {
  try {
    await admin().rpc('log_delta_debug', { payload: { judge: 'ultracut', ...fields } })
  } catch {
    /* never let the diagnostic break the run */
  }
}

async function finalize(apiKey: string, model: string, payload: string, proposal: unknown): Promise<string> {
  const userText =
    `${payload}\nFIRST-PASS PROPOSED EDL:\n${JSON.stringify(proposal)}\n\nVerify it, guarantee ZERO repeats remain (keep the LAST take of every duplicate), keep the kept script coherent, and return the final EDL.`
  const provider = providerConfig()
  const body: Record<string, unknown> = {
    model,
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
      'X-Title': 'EaseCutPro Ultracut'
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
  await logDebug({
    model,
    provider: 'openrouter',
    http_status: r.status,
    ok: r.ok,
    content_len: content.length,
    cleaned_len: cleaned.length,
    content_snippet: content.slice(0, 3000),
    err_body: r.ok ? null : bodyText.slice(0, 2000),
    raw_body: bodyText.slice(0, 8000),
    req_payload: payload.slice(0, 16000)
  })
  if (!r.ok) throw new Error(`model API: HTTP ${r.status} ${bodyText.slice(0, 200)}`)
  return cleaned
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const { payload, proposal, model: requestedModel } = await req
      .json()
      .catch(() => ({ payload: null, proposal: null, model: null }))
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)
    const model = resolveModel(requestedModel)

    const apiKey = await getApiKey()
    if (!apiKey) return json({ raw: null, judge: 'none' })
    try {
      return json({ raw: await finalize(apiKey, model, payload, proposal ?? { word_cuts: [], pause_cuts: [] }), judge: `ultracut:${model}` })
    } catch (e) {
      console.warn('[ultracut-judge] model API failed:', (e as Error).message)
      return json({ raw: null, judge: `ultracut:${model}` })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
