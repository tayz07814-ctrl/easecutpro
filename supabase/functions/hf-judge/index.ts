// EaseCutPro — Retake δ (Delta) cloud judge edge function.
//
// A COPY of procut-judge's contract, but the finalizer is the creator's OWN
// model served over the Hugging Face Inference Router (OpenAI-compatible) instead
// of Claude. Retake β (procut-judge / Claude Opus) is left completely UNTOUCHED;
// this is a separate function that only the Retake δ button calls, so production
// is unaffected.
//
// Same request/response shape as procut-judge (ProcutJudgeReq/Res): the browser
// sends the index-anchored transcript payload + an empty first-pass proposal and
// gets back the model's raw EDL text, parsed client-side with the SAME validateEdl
// as Retake β. raw:null on any failure so the cut job always completes (nothing
// staged rather than a hard error).
//
// Config (Supabase secrets):
//   HF_TOKEN  — required. Hugging Face access token (hf_…). Without it this
//               returns judge:'none' and nothing is cut.
//   HF_MODEL  — optional. Router model id in `<org>/<model>:<provider>` form.
//               Defaults to Qwen/Qwen3-4B:featherless-ai. Swap it to any
//               router-served model (bigger = better cuts).

import { createClient } from 'npm:@supabase/supabase-js@2'

// ---- inlined http helpers (self-contained so this deploys as a single file) ----
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

// Hugging Face Inference Router — OpenAI-compatible chat completions.
const HF_BASE = 'https://router.huggingface.co/v1'
const HF_MODEL = Deno.env.get('HF_MODEL') ?? 'Qwen/Qwen3-4B:featherless-ai'

// The token is NEVER hardcoded. Prefer an edge secret (HF_TOKEN); otherwise read
// it from the Supabase Vault via the service-role-only public.hf_secret() RPC.
async function getHfToken(): Promise<string> {
  const env = Deno.env.get('HF_TOKEN')
  if (env) return env
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data } = await admin.rpc('hf_secret')
    if (typeof data === 'string' && data) return data
  } catch {
    /* vault not configured — fall through to unconfigured */
  }
  return ''
}

const EDL_SHAPE = `Reply with VALID JSON ONLY (no prose, no markdown fences), exactly:
{"word_cuts":[{"from":12,"to":18,"reason":"earlier take of this line; kept the later one"}],
 "pause_cuts":[{"pause_id":"p3","keep_ms":150,"reason":"dead air; keep a beat"}]}
word_cuts use INCLUSIVE word indices from the list. pause_cuts reference pause ids; keep_ms=0 removes the pause entirely, otherwise that many ms remain.`

// Mirrored from procut-judge SYSTEM (kept in sync). The first pass is always empty
// in the cloud, so the "perform the full analysis yourself" clause makes the model
// do the whole cut from the transcript map.
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

async function hfFinalize(token: string, payload: string, proposal: unknown): Promise<string> {
  const userText =
    `${payload}\nFIRST-PASS PROPOSED EDL:\n${JSON.stringify(proposal)}\n\nVerify it, guarantee ZERO repeats remain (keep the LAST take of every duplicate), keep the kept script coherent, and return the final EDL.`
  const r = await fetch(`${HF_BASE}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: HF_MODEL,
      max_tokens: 16000,
      temperature: 0,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userText }
      ]
    })
  })
  if (!r.ok) throw new Error(`HF router: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const d = (await r.json()) as { choices?: { message?: { content?: string } }[] }
  let text = d.choices?.[0]?.message?.content ?? ''
  // Reasoning models (Qwen3 etc.) wrap their chain-of-thought in <think>…</think>;
  // strip it so only the JSON EDL reaches the client's validateEdl parser.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  return text
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const { payload, proposal } = await req.json().catch(() => ({ payload: null, proposal: null }))
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)

    const token = await getHfToken()
    if (!token) return json({ raw: null, judge: 'none' })
    try {
      return json({ raw: await hfFinalize(token, payload, proposal ?? { word_cuts: [], pause_cuts: [] }), judge: `hf:${HF_MODEL}` })
    } catch (e) {
      console.warn('[hf-judge] HF router failed:', (e as Error).message)
      return json({ raw: null, judge: `hf:${HF_MODEL}` })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
