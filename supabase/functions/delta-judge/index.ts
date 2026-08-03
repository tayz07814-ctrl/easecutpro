// EaseCutPro — Retake δ (Delta) cloud judge edge function.
//
// The finalizer is Claude Opus, called on our OWN OFFICIAL Anthropic API key
// (ANTHROPIC_API_KEY in Supabase — the SAME key procut-judge / moment-vision /
// overlay-suggest use). NO reseller, NO OpenRouter: every request goes straight
// to https://api.anthropic.com/v1/messages.
//
// Retake β (procut-judge) is left UNTOUCHED; only the Retake δ button calls this,
// so production is unaffected.
//
// LATENCY — the whole "press δ → cuts" flow must stay ~40s incl. ~23s
// transcription, so the judge has ~15s, and Supabase's edge wall-clock hard limit
// is 150s. Opus runs WITHOUT extended thinking (same as procut-judge: omitting the
// param = no reasoning on this tier), which produced the best cuts AND keeps it
// ~20s, clear of the wall-clock limit.
//
// The SYSTEM prompt forces WHOLE-TAKE SPAN cuts (not scattered word/filler removal),
// which is what makes the model produce pro-quality edits.
//
// Same request/response shape as procut-judge; raw:null on any failure so the cut
// job always completes.
//
// Config:
//   ANTHROPIC_API_KEY — required. Our official Anthropic key (Supabase edge secret).
//   DELTA_MODEL       — optional. Default claude-opus-4-8 (must be a Claude model).
//
// A branch build may A/B a different Claude tier per-request (model:'claude-…',
// whitelisted server-side); every other branch omits it and gets the safe default.
// Every allowed model is billed on our official ANTHROPIC_API_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { gate } from '../_shared/gate.ts'

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

const MODEL = Deno.env.get('DELTA_MODEL') ?? 'claude-opus-4-8'

// Per-request model override (A/B testing from a specific branch build) — Anthropic
// (claude-*) models ONLY, whitelisted so a signed-in user can't route to an
// arbitrary/expensive model. All of these bill on our official ANTHROPIC_API_KEY;
// DELTA_MODEL env still wins over the code default.
const MODEL_WHITELIST = new Set([
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-haiku-4-5'
])
function resolveModel(requested: unknown): string {
  return typeof requested === 'string' && MODEL_WHITELIST.has(requested) ? requested : MODEL
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

// Pull the JSON EDL out of a model reply: drop <think> reasoning and ```fences```,
// then keep the outermost {...} object.
function extractEdl(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  t = t.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const m = t.match(/\{[\s\S]*\}/)
  return (m ? m[0] : t).trim()
}

// Whole-take-span prompt — the key to pro-quality cuts. Forces contiguous span
// cuts of entire earlier takes, never scattered word/filler removal.
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

// The single user turn — the transcript payload + first-pass proposal to verify.
function buildUserText(payload: string, proposal: unknown): string {
  return `${payload}\nFIRST-PASS PROPOSED EDL:\n${JSON.stringify(proposal)}\n\nVerify it, guarantee ZERO repeats remain (keep the LAST take of every duplicate), keep the kept script coherent, and return the final EDL.`
}

// DIAGNOSTIC (temporary): confirm the first real run post-fix. Harmless (try/catch);
// removed in cleanup.
async function logDebug(fields: Record<string, unknown>): Promise<void> {
  try {
    await admin().rpc('log_delta_debug', { payload: fields })
  } catch {
    /* never let the diagnostic break the run */
  }
}

// OFFICIAL Anthropic API — Claude Opus on our own ANTHROPIC_API_KEY. Mirrors
// procut-judge exactly: `system` top-level, no thinking config (fast + best cuts
// on Opus at this tier).
async function finalize(apiKey: string, model: string, payload: string, proposal: unknown): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildUserText(payload, proposal) }]
    })
  })
  const bodyText = await r.text()
  let content = ''
  if (r.ok) {
    try {
      const d = JSON.parse(bodyText) as { content?: { type: string; text?: string }[] }
      content = (d.content ?? []).map((b) => b.text ?? '').join('')
    } catch {
      /* non-JSON body */
    }
  }
  const cleaned = extractEdl(content)
  await logDebug({
    model,
    provider: 'anthropic',
    http_status: r.status,
    ok: r.ok,
    content_len: content.length,
    cleaned_len: cleaned.length,
    content_snippet: content.slice(0, 3000),
    err_body: r.ok ? null : bodyText.slice(0, 2000),
    raw_body: bodyText.slice(0, 8000),
    req_payload: payload.slice(0, 16000)
  })
  if (!r.ok) throw new Error(`Anthropic API: HTTP ${r.status} ${bodyText.slice(0, 200)}`)
  return cleaned
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    // Auth + payload cap + one AI credit, charged BEFORE the model call.
    const g = await gate(req, 1)
    if (!g.ok) return g.res
    const { payload, proposal, model: requestedModel } = g.ctx.body
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)
    const model = resolveModel(requestedModel)

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!apiKey) return json({ raw: null, judge: 'none' })
    try {
      return json({ raw: await finalize(apiKey, model, payload, proposal ?? { word_cuts: [], pause_cuts: [] }), judge: `delta:${model}` })
    } catch (e) {
      console.warn('[delta-judge] Anthropic API failed:', (e as Error).message)
      return json({ raw: null, judge: `delta:${model}` })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
