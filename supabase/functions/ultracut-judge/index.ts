// EaseCutPro — Ultracut (Beta) cloud judge edge function.
//
// Single-pass retake judge (payload → { raw, judge }). raw:null on any failure so
// the cut job always completes.
//
// RELIABILITY (this version):
//  • STREAMING KEEP-ALIVE: the response is a stream that emits a space every 20s
//    while the model runs, so Supabase's 150s IDLE timeout never 504s a long run.
//    On Pro the worker window is 400s, so medium reasoning has room. The keep-alive
//    bytes are JSON whitespace, so the final {raw,judge} object (appended last)
//    still parses on the client.
//  • TIME BUDGET: the primary is aborted at PRIMARY_BUDGET_MS (< 400s), leaving
//    room for the fast fallback, so a run always returns before the worker limit.
//  • FIRST-PARTY ROUTING: primary + fallback are DeepSeek first-party models
//    (api.deepseek.com — concurrency-limited, NOT the OpenRouter shared rate pool
//    that returned 429). Fallback is deepseek-v4-pro (the provider only supports
//    deepseek-v4-pro / deepseek-v4-flash).
//  • TOKENS: max_tokens 20000 on the direct path so the EDL is never clipped by
//    the chain-of-thought.

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

const DEEPSEEK_BASE_URL = Deno.env.get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com'
const DEEPSEEK_DIRECT = new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat'])

const MODEL_WHITELIST = new Set([
  'z-ai/glm-5.2',
  'deepseek/deepseek-v3.2-exp',
  'google/gemini-3.6-flash',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.5-flash',
  'qwen/qwen3.7-plus',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-v4-flash',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'meta-llama/llama-4-maverick'
])
function resolveModel(requested: unknown): string {
  return typeof requested === 'string' && MODEL_WHITELIST.has(requested) ? requested : MODEL
}

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

function reasoningOverride(v: unknown): Record<string, unknown> | null {
  if (v === 'off' || v === false) return { enabled: false }
  if (v === 'low' || v === 'medium' || v === 'high') return { effort: v }
  if (typeof v === 'number' && v > 0) return { max_tokens: Math.min(v, 8000) }
  return null
}

function deepseekEffort(v: unknown): string | undefined {
  if (v === 'low' || v === 'medium' || v === 'high') return v
  return undefined
}

function providerConfig(): Record<string, unknown> | undefined {
  const sort = Deno.env.get('ULTRACUT_PROVIDER_SORT')?.toLowerCase()
  if (sort === 'throughput' || sort === 'latency' || sort === 'price') return { sort }
  return undefined
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

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

function extractEdl(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  t = t.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const m = t.match(/\{[\s\S]*\}/)
  return (m ? m[0] : t).trim()
}

const SYSTEM = `You are a professional transcript-based video editing AI.

You are editing a raw spoken transcript.

Goal:
Produce an Edit Decision List (EDL) that removes recording mistakes without changing the intended message.

Remove only:
- Earlier retakes (keep exactly ONE complete take, usually the last complete one).
- Abandoned sentence starts.
- Production chatter (talking to the editor, camera, crew, or about recording).
- Accidental stutters or immediate repeated words.

Keep:
- All unique content.
- Intentional emphasis or stylistic repetition.
- The speaker's wording.

Rules:
- Never rewrite or reorder words.
- Never delete unique information.
- Remove whole abandoned attempts, never splice two takes together.
- Cuts must not overlap.
- When unsure, KEEP.

Return ONLY valid JSON:

{
  "word_cuts": [
    {
      "from": 0,
      "to": 10,
      "reason": "retake"
    }
  ],
  "pause_cuts": [
    {
      "pause_id": "p3",
      "keep_ms": 150,
      "reason": "dead air"
    }
  ]
}

`

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return !!data.user
}

async function logDebug(fields: Record<string, unknown>): Promise<void> {
  try {
    await admin().rpc('log_delta_debug', { payload: { judge: 'ultracut', ...fields } })
  } catch {
    /* never let the diagnostic break the run */
  }
}

async function callModel(
  keys: { openrouter: string; deepseek: string },
  model: string,
  payload: string,
  system: string,
  reasoningIntent: unknown,
  signal?: AbortSignal
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
    body.max_tokens = 20000
  } else {
    body.reasoning = reasoningOverride(reasoningIntent) ?? reasoningConfig()
    const provider = providerConfig()
    if (provider) body.provider = provider
  }
  let r: Response
  try {
    r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://easecutpro.com',
        'X-Title': 'EaseCutPro Ultracut'
      },
      body: JSON.stringify(body),
      signal
    })
  } catch (e) {
    await logDebug({ model, provider: direct ? 'deepseek' : 'openrouter', aborted: true, err: (e as Error).message })
    return { ok: false, status: 0, cleaned: '' }
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

// Abort the primary before the Pro 400s worker limit, leaving time for the fast
// fallback to still return a result.
const PRIMARY_BUDGET_MS = 340000
// Fallback: DeepSeek first-party deepseek-v4-pro (the provider supports only
// deepseek-v4-pro / deepseek-v4-flash), low reasoning so it returns quickly with
// non-empty content.
const FALLBACK_MODEL = 'deepseek-v4-pro'
async function finalize(
  keys: { openrouter: string; deepseek: string },
  model: string,
  payload: string,
  system: string,
  reasoningIntent: unknown
): Promise<{ raw: string; model: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PRIMARY_BUDGET_MS)
  let primary: { ok: boolean; status: number; cleaned: string }
  try {
    primary = await callModel(keys, model, payload, system, reasoningIntent, ctrl.signal)
  } finally {
    clearTimeout(timer)
  }
  if (primary.ok) return { raw: primary.cleaned, model }
  if (model !== FALLBACK_MODEL) {
    const fb = await callModel(keys, FALLBACK_MODEL, payload, system, 'low')
    if (fb.ok) return { raw: fb.cleaned, model: FALLBACK_MODEL }
  }
  throw new Error(
    `model API failed or timed out (primary HTTP ${primary.status}${model !== FALLBACK_MODEL ? '; fallback also failed' : ''})`
  )
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const { payload, model: requestedModel, promptVariant, reasoning } = await req
      .json()
      .catch(() => ({ payload: null, model: null, promptVariant: null, reasoning: null }))
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)
    const model = resolveModel(requestedModel)
    const system = resolvePrompt(promptVariant)
    const suffix = typeof promptVariant === 'string' && promptVariant ? `:${promptVariant}` : ''
    const tag = `ultracut:${model}${suffix}`

    const keys = { openrouter: await getApiKey(), deepseek: Deno.env.get('DEEPSEEK_API_KEY') ?? '' }
    if (!keys.openrouter && !keys.deepseek) return json({ raw: null, judge: 'none' })

    // Stream a space every 20s so Supabase's 150s IDLE timeout never 504s a long
    // medium run (Pro worker window is 400s). Keep-alive bytes are JSON whitespace,
    // so the final {raw,judge} object appended at the end still parses on the client.
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const beat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(' '))
          } catch {
            /* stream closed */
          }
        }, 20000)
        let out: unknown
        try {
          const r = await finalize(keys, model, payload, system, reasoning)
          out = { raw: r.raw, judge: `ultracut:${r.model}${suffix}` }
        } catch (e) {
          console.warn('[ultracut-judge] model API failed:', (e as Error).message)
          out = { raw: null, judge: tag }
        } finally {
          clearInterval(beat)
          try {
            controller.enqueue(encoder.encode(JSON.stringify(out)))
          } catch {
            /* stream closed */
          }
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
      }
    })
    return new Response(stream, { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
