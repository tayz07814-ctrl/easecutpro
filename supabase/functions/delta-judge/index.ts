// EaseCutPro — Retake δ (Delta) cloud judge edge function.
//
// The finalizer is the creator's OWN model over an OpenAI-compatible API
// (OpenRouter). Retake β (procut-judge / Claude Opus) is left UNTOUCHED; only the
// Retake δ button calls this, so production is unaffected.
//
// MODEL CHOICE / LATENCY — this is the crux. Supabase edge functions have a hard
// 150s wall-clock limit, and the whole "press δ → cuts" flow must stay ~40s incl.
// ~23s of transcription, so the judge has ~15s. deepseek/deepseek-v4-pro (1.6T
// params) reasons for ~172s on a real transcript → HTTP 546 (killed) → no cuts, on
// ANY provider. Its fast sibling deepseek/deepseek-v4-flash returns the SAME cuts
// WITH reasoning in ~4-8s. So the default model is the flash variant, and reasoning
// is kept ON (effort=high) — quality AND speed. Benchmarked head-to-head: flash@high
// solved the same hard overlapping-retake tangle as pro, in 4s vs 150s+.
//
// Same request/response shape as procut-judge (ProcutJudgeReq/Res); raw:null on any
// failure so the cut job always completes.
//
// Config:
//   DELTA_JUDGE_KEY  — required. OpenRouter sk-or-… key. Edge secret OR Supabase
//                      Vault via the service-role-only delta_judge_key() RPC.
//   DELTA_BASE_URL   — optional. Default https://openrouter.ai/api/v1.
//   DELTA_MODEL      — optional. Default deepseek/deepseek-v4-flash.
//   DELTA_REASONING_EFFORT      — optional. low|medium|high|off. Default high.
//   DELTA_REASONING_MAX_TOKENS  — optional alt. Positive int caps reasoning tokens;
//                                 0 disables. (effort takes precedence if both set.)

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
const MODEL = Deno.env.get('DELTA_MODEL') ?? 'deepseek/deepseek-v4-flash'

// Reasoning control. Default effort=high — on the flash model that is still ~4-8s
// while keeping full cut quality. `off` disables reasoning entirely. A positive
// DELTA_REASONING_MAX_TOKENS caps reasoning by token budget instead (0 disables).
function reasoningConfig(): Record<string, unknown> {
  const effort = Deno.env.get('DELTA_REASONING_EFFORT')?.toLowerCase()
  if (effort === 'off') return { enabled: false }
  if (effort === 'low' || effort === 'medium' || effort === 'high') return { effort }
  const raw = Deno.env.get('DELTA_REASONING_MAX_TOKENS')
  if (raw !== undefined && raw !== '') {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n)) return n > 0 ? { max_tokens: n } : { enabled: false }
  }
  return { effort: 'high' }
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

const EDL_SHAPE = `Reply with VALID JSON ONLY (no prose, no markdown fences), exactly:
{"word_cuts":[{"from":12,"to":18,"reason":"earlier take of this line; kept the later one"}],
 "pause_cuts":[{"pause_id":"p3","keep_ms":150,"reason":"dead air; keep a beat"}]}
word_cuts use INCLUSIVE word indices from the list. pause_cuts reference pause ids; keep_ms=0 removes the pause entirely, otherwise that many ms remain.`

const SYSTEM = `You are the SECOND PASS (verification + finalization) of a professional video cutting pipeline. GOAL: after your cuts the kept transcript must contain ZERO repeated sentences/lines and read as one coherent script. You receive the index-anchored VERBATIM transcript map and the FIRST PASS's proposed EDL.

Finalize it:
- Re-scan the WHOLE transcript for any repeated take or line the first pass missed or only partially cut. For every group of duplicate takes, make sure ONLY THE LAST take survives — the last occurrence IN TIME, never an earlier one, even if the earlier take reads cleaner. Add or extend word_cuts to delete the earlier copies ENTIRELY (their opening words included).
- Remove any PRODUCTION ARTIFACTS the first pass missed: slates/count-ins/take markers ("skip 10, hook one", "take three"), the speaker talking ABOUT the recording instead of TO the audience (planning a take out loud, directing someone off-camera), and session wrap markers at the very start/end ("okay, that's it", "cut"). Audience-facing outros ("that's it for today, thanks for watching") are content — keep them.
- Remove any leftover stutters or double-spoken words.
- Never leave a broken or dangling half-sentence: the words that remain must flow as a script.
- CUT WHOLE TAKES ONLY: retake cuts run from the earlier take's first word to the word before the surviving take begins — never splice half of one take onto half of another; never start or end a cut mid-sentence. REMOVE any first-pass cut that violates this by EXTENDING it to the full take boundary.
- THE ONLY COPY of an idea is untouchable: verbal mistakes, hedges and filler words inside the only take of a line are NOT cuts — DELETE any first-pass cut whose reason is just "filler"/"cleaner delivery"/"incomplete thought" unless a later take of the same line survives.
- Keep the first pass's correct cuts; only add/adjust what's needed to reach zero repeats.
- If the proposed EDL is empty, perform the full analysis yourself.
Return the DEFINITIVE final EDL (same ids/indices; your reply FULLY REPLACES the proposal).

${EDL_SHAPE}`

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
  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://easecutpro.com',
      'X-Title': 'EaseCutPro Retake delta'
    },
    // reasoning kept ON but on the fast flash model (see reasoningConfig / header).
    // No `temperature` — reasoning models reject non-default values.
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      stream: false,
      reasoning: reasoningConfig(),
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userText }
      ]
    })
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
        raw_body: bodyText.slice(0, 8000)
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
