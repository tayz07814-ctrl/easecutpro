// EaseCutPro — retake04-judge (easecut0.04 test branch ONLY).
//
// An ISOLATED clone of the ultracut-judge cloud judge whose ONLY difference is the
// system prompt: it runs the creator's new, tighter retake-editor prompt (SYSTEM
// below) instead of ultracut-judge's word-list/'sharp' prompt. It exists so the
// easecut0.04 preview build can test that prompt on the real Retake β path WITHOUT
// touching the shared `ultracut-judge` function that production / main still use.
// Nothing on main references this function, so deploying it cannot change main.
//
// All the robustness of ultracut-judge is preserved byte-for-byte: the same model
// resolution + whitelist, DeepSeek-first-party vs OpenRouter routing, per-request
// reasoning, the 105s AbortController timeout, and the fast-model fallback — so the
// ONLY behavioural change vs Retake β today is the prompt text. Request/response
// shape matches ultracut-judge (payload → { raw, judge }); raw:null on any failure.
//
// Config (identical env to ultracut-judge — project-wide secrets, shared):
//   ULTRACUT_JUDGE_KEY / OPEN_ROUTER_KEY — OpenRouter key (Vault fallback).
//   DEEPSEEK_API_KEY  — DeepSeek first-party key (for DEEPSEEK_DIRECT ids).
//   ULTRACUT_BASE_URL / ULTRACUT_MODEL / ULTRACUT_REASONING_* / ULTRACUT_PROVIDER_SORT.

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

// DeepSeek FIRST-PARTY route (api.deepseek.com) — caps by concurrency, not a shared
// rate pool. Any model listed here is sent to DeepSeek with DEEPSEEK_API_KEY; every
// other model keeps the OpenRouter path byte-for-byte unchanged.
const DEEPSEEK_BASE_URL = Deno.env.get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com'
const DEEPSEEK_DIRECT = new Set(['deepseek-v4-flash', 'deepseek-v4-pro'])

// Per-request model override — whitelisted so a signed-in user can't route to an
// arbitrary/expensive model. ULTRACUT_MODEL env still wins over the code default.
const MODEL_WHITELIST = new Set([
  'z-ai/glm-5.2',
  'google/gemini-2.5-flash-lite',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.5-flash',
  'qwen/qwen3.7-plus',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-v4-flash',
  'deepseek-v4-flash',
  'deepseek-v4-pro'
])
function resolveModel(requested: unknown): string {
  return typeof requested === 'string' && MODEL_WHITELIST.has(requested) ? requested : MODEL
}

// Reasoning control. Default effort=low; ULTRACUT_REASONING_EFFORT=off disables it.
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

// Per-request reasoning override (whitelisted values only). Retake β sends 'off'.
function reasoningOverride(v: unknown): Record<string, unknown> | null {
  if (v === 'off' || v === false) return { enabled: false }
  if (v === 'low' || v === 'medium' || v === 'high') return { effort: v }
  if (typeof v === 'number' && v > 0) return { max_tokens: Math.min(v, 8000) }
  return null
}

// DeepSeek first-party takes a top-level `reasoning_effort` string (low|medium|high).
function deepseekEffort(v: unknown): string | undefined {
  if (v === 'low' || v === 'medium' || v === 'high') return v
  return undefined
}

// Provider routing. DEFAULT: none. Opt into a sort via ULTRACUT_PROVIDER_SORT only.
function providerConfig(): Record<string, unknown> | undefined {
  const sort = Deno.env.get('ULTRACUT_PROVIDER_SORT')?.toLowerCase()
  if (sort === 'throughput' || sort === 'latency' || sort === 'price') return { sort }
  return undefined
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

// OpenRouter key. NEVER hardcoded. Prefer ULTRACUT_JUDGE_KEY, then OPEN_ROUTER_KEY,
// then the Supabase Vault delta_judge_key() RPC.
async function getApiKey(): Promise<string> {
  const env = Deno.env.get('ULTRACUT_JUDGE_KEY') ?? Deno.env.get('OPEN_ROUTER_KEY')
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

// ==========================================================================
// The creator's retake-editor prompt (easecut0.04). This is the ONLY prompt this
// function ever runs — there are no variants. To change the retake behaviour on the
// easecut0.04 preview, edit THIS string and redeploy retake04-judge (main untouched).
// ==========================================================================
const SYSTEM = `You are a transcript-based video editor.

Your job is ONLY to remove retakes, abandoned attempts, production chatter, and accidental repetitions.

Do NOT rewrite, summarize, or improve wording.

The remaining transcript must read like one continuous recording.

RULES

1. RETAKES
If the speaker records the same idea multiple times, KEEP ONLY THE LAST COMPLETE TAKE.

Different wording with the same meaning still counts as the same retake.

2. ABANDONED ATTEMPTS

If the speaker starts a sentence but immediately restarts it, remove the abandoned attempt.

Example:

"I think the—"
"I think the best solution..."

Keep only the second.

3. PARTIAL RETAKES

If only the end of a sentence is repeated, remove ONLY the repeated section.

Keep unique lead-ins.

4. STUTTERS

Remove accidental repeated words.

Keep intentional repetition for emphasis.

5. PRODUCTION CHATTER

Remove things like:

sorry
oops
again
rolling
cut
take two
hold on
I messed up
camera directions
crew conversation

Only remove them if they are NOT part of the intended script.

6. NEVER REMOVE

Unique information.

New examples.

New explanations.

New arguments.

OUTPUT

Return ONLY

{
  "word_cuts":[
    {
      "from":0,
      "to":15,
      "reason":"retake"
    }
  ],
  "pause_cuts":[]
}

Use inclusive word indices.
Return valid JSON only.`

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return !!data.user
}

// DIAGNOSTIC: tag rows with judge:'retake04' so this function's runs are
// distinguishable from ultracut's in delta_debug. Harmless (try/catch).
async function logDebug(fields: Record<string, unknown>): Promise<void> {
  try {
    await admin().rpc('log_delta_debug', { payload: { judge: 'retake04', ...fields } })
  } catch {
    /* never let the diagnostic break the run */
  }
}

// One model call: POST to the model's API (DeepSeek first-party for DEEPSEEK_DIRECT
// ids, else OpenRouter), log the attempt, and return the cleaned EDL plus whether it
// USABLY succeeded. reasoningIntent is the RAW per-request value; it is encoded per route.
async function callModel(
  keys: { openrouter: string; deepseek: string },
  model: string,
  payload: string,
  system: string,
  reasoningIntent: unknown,
  timeoutMs = 105_000
): Promise<{ ok: boolean; status: number; cleaned: string }> {
  const direct = DEEPSEEK_DIRECT.has(model)
  const base = direct ? DEEPSEEK_BASE_URL : BASE_URL
  const apiKey = direct ? keys.deepseek : keys.openrouter
  if (!apiKey) return { ok: false, status: 0, cleaned: '' }
  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: payload }
    ]
  }
  if (direct) {
    const eff = deepseekEffort(reasoningIntent)
    if (eff) body.reasoning_effort = eff
    body.max_tokens = 8000
  } else {
    body.reasoning = reasoningOverride(reasoningIntent) ?? reasoningConfig()
    const provider = providerConfig()
    if (provider) body.provider = provider
  }
  // Abort before Supabase's ~150s edge wall-clock kills the WHOLE function (which
  // returns raw:null → the client sees "judge failed" and ZERO cuts). On timeout we
  // return ok:false so finalize() falls back to the fast model within budget.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let r: Response
  try {
    r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://easecutpro.com',
        'X-Title': 'EaseCutPro retake04'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
  } catch (e) {
    clearTimeout(timer)
    const aborted = ctrl.signal.aborted
    await logDebug({
      model,
      provider: direct ? 'deepseek' : 'openrouter',
      http_status: aborted ? 408 : 0,
      ok: false,
      aborted,
      timeout_ms: timeoutMs,
      err_body: (e as Error).message?.slice(0, 500) ?? null,
      req_payload: payload.slice(0, 16000)
    })
    return { ok: false, status: aborted ? 408 : 0, cleaned: '' }
  }
  clearTimeout(timer)
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
    provider: direct ? 'deepseek' : 'openrouter',
    http_status: r.status,
    ok: r.ok,
    content_len: content.length,
    cleaned_len: cleaned.length,
    content_snippet: content.slice(0, 3000),
    err_body: r.ok ? null : bodyText.slice(0, 2000),
    raw_body: bodyText.slice(0, 8000),
    req_payload: payload.slice(0, 16000)
  })
  return { ok: r.ok && cleaned.length > 0, status: r.status, cleaned }
}

// RELIABILITY FALLBACK: if the primary judge fails we fall back to deepseek-chat on
// OpenRouter — a different vendor+key — so a transient outage never returns ZERO cuts.
const FALLBACK_MODEL = 'deepseek/deepseek-chat'
async function finalize(
  keys: { openrouter: string; deepseek: string },
  model: string,
  payload: string,
  system: string,
  reasoningIntent: unknown
): Promise<{ raw: string; model: string }> {
  const primary = await callModel(keys, model, payload, system, reasoningIntent, 105_000)
  if (primary.ok) return { raw: primary.cleaned, model }
  if (model !== FALLBACK_MODEL) {
    const fb = await callModel(keys, FALLBACK_MODEL, payload, system, 'off', 35_000)
    if (fb.ok) return { raw: fb.cleaned, model: FALLBACK_MODEL }
  }
  throw new Error(
    `model API failed (primary HTTP ${primary.status}${model !== FALLBACK_MODEL ? '; fallback also failed' : ''})`
  )
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const { payload, model: requestedModel, reasoning } = await req
      .json()
      .catch(() => ({ payload: null, model: null, reasoning: null }))
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)
    const model = resolveModel(requestedModel)
    // retake04 has exactly ONE prompt — promptVariant is ignored on purpose.
    const system = SYSTEM
    const tag = `retake04:${model}`

    const keys = { openrouter: await getApiKey(), deepseek: Deno.env.get('DEEPSEEK_API_KEY') ?? '' }
    if (!keys.openrouter && !keys.deepseek) return json({ raw: null, judge: 'none' })
    try {
      const out = await finalize(keys, model, payload, system, reasoning)
      const usedTag = `retake04:${out.model}`
      return json({ raw: out.raw, judge: usedTag })
    } catch (e) {
      console.warn('[retake04-judge] model API failed:', (e as Error).message)
      return json({ raw: null, judge: tag })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
