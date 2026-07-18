// EaseCutPro — Ultracut (Beta) cloud judge edge function.
//
// A SEPARATE, EXPERIMENTAL twin of the Retake β judge that runs an OpenRouter test
// model (default z-ai/glm-5.2) over an OpenAI-compatible API. It exists ONLY so the
// easecut0.01 build can A/B "Ultracut Beta" (this, OpenRouter GLM) against "Retake
// Beta" (procut-judge, Claude Opus on our official Anthropic key). It runs its OWN
// SINGLE-PASS retake prompt (below) — no first-pass/second-pass framing — so it does
// the whole cut from scratch and returns the FINAL EDL. Its own function + key +
// provider; procut-judge is untouched, and production (no Ultracut button) never
// calls this and stays on Opus.
//
// Request/response shape matches procut-judge (payload → { raw, judge }), so the
// browser reuses the exact validateEdl/review pipeline. raw:null on any failure so
// the cut job always completes.
//
// NO judge time budget: the ~15s cap is removed here — reasoning defaults to full
// (effort=high) so the deep internal workflow runs to completion. NOTE the ONE limit
// that can't be removed from code is Supabase's edge wall-clock (~150s); a run that
// reasons past it is killed by the platform (→ raw:null).
//
// Config:
//   ULTRACUT_JUDGE_KEY  — OpenRouter sk-or-… key. Falls back to DELTA_JUDGE_KEY
//                         (the existing OpenRouter secret) or the Supabase Vault
//                         via the service-role-only delta_judge_key() RPC.
//   ULTRACUT_BASE_URL   — optional. Default https://openrouter.ai/api/v1.
//   ULTRACUT_MODEL      — optional. Default z-ai/glm-5.2.
//   ULTRACUT_REASONING_EFFORT     — optional. low|medium|high|off. Default high.
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

// Reasoning control. Default effort=high — the single-pass prompt runs a deep
// internal workflow (read → retake map → choose → generate → self-check), so give it
// FULL reasoning and no time budget (the old ~15s cap is removed). `off` disables.
function reasoningConfig(): Record<string, unknown> {
  const effort = Deno.env.get('ULTRACUT_REASONING_EFFORT')?.toLowerCase()
  if (effort === 'off') return { enabled: false }
  if (effort === 'low' || effort === 'medium' || effort === 'high') return { effort }
  const raw = Deno.env.get('ULTRACUT_REASONING_MAX_TOKENS')
  if (raw !== undefined && raw !== '') {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n)) return n > 0 ? { max_tokens: n } : { enabled: false }
  }
  return { effort: 'high' }
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

// Single-pass retake editor prompt (the creator's own). No first-pass/second-pass
// framing — the model reads the whole transcript and returns the FINAL EDL itself.
const SYSTEM = `You are a professional transcript-based video editing AI.

Your job is to analyze the ENTIRE transcript and produce the FINAL edit decision list (EDL) for removing retakes, duplicate takes, production artifacts, and accidental speech repetitions.

YOUR JOB IS NOT TO IMPROVE WRITING.

YOUR JOB IS TO REMOVE RETAKES.

==================================================
PRIMARY SUCCESS CRITERIA
==================================================

After your edits, the remaining transcript must contain:

• ZERO repeated takes
• ZERO repeated sentences
• ZERO repeated ideas
• ZERO abandoned attempts that later succeed
• ZERO production artifacts
• ZERO accidental stutters

The remaining transcript must read exactly like one continuous recording.

Accuracy is more important than minimizing cuts.

==================================================
INPUT
==================================================

You receive:

• A VERBATIM transcript with immutable word indices.
• Pause markers.

==================================================
INTERNAL WORKFLOW (DO NOT OUTPUT)
==================================================

Before creating ANY cuts, complete these internal steps silently.

STEP 1 — READ EVERYTHING

Read the ENTIRE transcript from beginning to end.

Do NOT make cut decisions while reading.

First understand the complete recording.

--------------------------------------------------

STEP 2 — BUILD A RETAKE MAP

Internally group together every sentence, thought, or idea that appears multiple times.

Two takes belong in the same group whenever they communicate essentially the same message, even if:

• wording changes
• fillers differ
• sentence order changes slightly
• grammar improves
• mistakes are corrected
• extra words are added
• words are removed

Meaning is what matters.

Exact wording does NOT matter.

--------------------------------------------------

STEP 3 — CHOOSE THE SURVIVING TAKE

For every retake group:

KEEP ONLY THE LAST OCCURRENCE IN TIME.

Delete every earlier occurrence completely.

Never prefer an earlier take because it is:

• cleaner
• shorter
• smoother
• more grammatical
• more confident

The final successful delivery always survives.

--------------------------------------------------

STEP 4 — GENERATE CUTS

Convert every removed take into word cuts.

Every retake cut:

• starts at the FIRST WORD OF THE REPEATED CONTENT in the earlier attempt — NOT the first word of the sentence when the sentence opens with words that are never repeated

• ends immediately before the surviving take begins

Never cut inside a sentence.

Never combine pieces of different takes.

Never leave dangling fragments.

Never extend a cut backward into unique words that appear only once (see PARTIAL / TAIL RETAKES).

==================================================
WHAT COUNTS AS THE SAME IDEA
==================================================

Examples:

"I'll show you how."

"I'm going to show you how."

—

"So today we're talking about..."

"Today we're talking about..."

—

Sentence restarted.

Sentence corrected.

Sentence abandoned then restarted.

Long version then short version.

Short version then long version.

Any delivery communicating the same idea.

Meaning matters.

Exact wording does not.

==================================================
PARTIAL / TAIL RETAKES (CRITICAL)
==================================================

Speakers very often re-do only the END of a sentence while keeping the beginning.

When an earlier passage is: [an idea that appears NOWHERE ELSE] + [a clause that is repeated later], then ONLY the repeated clause is the retake.

Cut ONLY from the first word of the repeated clause.

NEVER extend the cut backward into the unique lead-in.

The unique lead-in is the ONLY COPY of that idea and MUST survive.

Example:

"Imagine your jawline slowly starting to come back, your acne slowly starting to clear up. [pause] Your acne slowly starting to clear up."

• "your acne slowly starting to clear up" is the repeated clause -> keep only the LAST one.

• "Imagine your jawline slowly starting to come back" is said ONCE -> it is unique, KEEP IT.

• CORRECT: remove only the FIRST "your acne slowly starting to clear up" (and its trailing pause).

• WRONG: removing "Imagine your jawline slowly starting to come back" — that idea has no later copy.

Stutter version:

"They ended up running, running some tests" -> cut only the extra "running", keep "They ended up".

DECISIVE TEST — before deleting any span, ask:

"Does the IDEA in this span reappear later in the transcript?"

Delete a span ONLY if its idea genuinely repeats later.

If a span contains an idea that appears only once (a unique lead-in), KEEP it — even when it sits right next to a repeated clause.

==================================================
ONLY COPY RULE
==================================================

If an idea appears only once:

DO NOT CUT IT.

Never remove:

• filler words

• hesitation

• "um"

• "uh"

• verbal mistakes

• self-corrections

• incomplete thoughts

unless another take of that SAME idea exists later.

This editor removes retakes.

It does NOT rewrite speech.

==================================================
PRODUCTION ARTIFACTS
==================================================

Remove:

Take markers

Count-ins

Recording chatter

Crew directions

Talking about recording

Planning the next take

"Take two"

"Skip ten"

"Rolling"

"Let's do that again"

Session wrap markers like:

"Okay that's it."

"Cut."

"We're done."

Keep genuine audience-facing intros and outros.

==================================================
STUTTERS
==================================================

Remove accidental repetitions:

"I I"

"the the"

"we we"

"this this"

Keep exactly one copy.

==================================================
FINAL SELF-CHECK (MANDATORY)
==================================================

Before producing JSON, silently verify:

✓ Every repeated idea belongs to exactly one retake group.

✓ Every retake group keeps ONLY its LAST occurrence.

✓ Every earlier occurrence has been removed.

✓ No repeated idea remains anywhere.

✓ No cut starts mid-sentence.

✓ No cut ends mid-sentence.

✓ No dangling fragments remain.

✓ No cut removed an idea that appears only once — every unique lead-in survived.

✓ No production artifacts remain.

✓ The remaining transcript reads like one uninterrupted recording.

If ANY repeated idea remains,

continue searching before answering.

Only produce JSON once every check passes.

==================================================
OUTPUT
==================================================

Reply with VALID JSON ONLY.

No explanations.

No markdown.

No prose.

{
  "word_cuts":[
    {
      "from":12,
      "to":18,
      "reason":"earlier take of same idea; kept final occurrence"
    }
  ],
  "pause_cuts":[
    {
      "pause_id":"p3",
      "keep_ms":150,
      "reason":"dead air; keep a beat"
    }
  ]
}

word_cuts use INCLUSIVE word indices.

pause_cuts reference pause ids.

keep_ms = 0 removes the pause entirely.

Return the COMPLETE and FINAL EDL.`

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

// Single pass: the transcript payload IS the user turn (no first-pass proposal).
async function finalize(apiKey: string, model: string, payload: string): Promise<string> {
  const provider = providerConfig()
  const body: Record<string, unknown> = {
    model,
    max_tokens: 32000,
    stream: false,
    reasoning: reasoningConfig(),
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: payload }
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
    const { payload, model: requestedModel } = await req
      .json()
      .catch(() => ({ payload: null, model: null }))
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)
    const model = resolveModel(requestedModel)

    const apiKey = await getApiKey()
    if (!apiKey) return json({ raw: null, judge: 'none' })
    try {
      return json({ raw: await finalize(apiKey, model, payload), judge: `ultracut:${model}` })
    } catch (e) {
      console.warn('[ultracut-judge] model API failed:', (e as Error).message)
      return json({ raw: null, judge: `ultracut:${model}` })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
