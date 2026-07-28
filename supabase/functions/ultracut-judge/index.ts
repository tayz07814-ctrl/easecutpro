// EaseCutPro — Ultracut (Beta) cloud judge edge function.
//
// Single-pass retake judge (payload → { raw, judge }). raw:null on any failure so
// the cut job always completes.
//
// RELIABILITY (this version):
//  • STREAMING KEEP-ALIVE: the response is a stream that emits a space every 20s
//    while the model runs, so Supabase's 150s IDLE timeout never 504s a long run.
//    On Pro the worker window is 400s, so low reasoning has room. The keep-alive
//    bytes are JSON whitespace, so the final {raw,judge} object (appended last)
//    still parses on the client.
//  • TIME BUDGET: the primary is aborted at PRIMARY_BUDGET_MS (< 400s), leaving
//    room for the fast fallback, so a run always returns before the worker limit.
//  • FIRST-PARTY ROUTING: primary model is Grok 4.5 via xAI API
//    (api.x.ai). Fallback is deepseek-v4-pro.
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
const MODEL = Deno.env.get('ULTRACUT_MODEL') ?? 'google/gemma-4-31b-it'

const DEEPSEEK_BASE_URL = Deno.env.get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com'
const DEEPSEEK_DIRECT = new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat'])

const MODEL_WHITELIST = new Set([
  'google/gemma-4-31b-it',
  'x-ai/grok-4.5',
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

You receive one VERBATIM transcript with immutable word indices.

Use only those words and indices. Do not infer or request any acoustic metadata.

==================================================
INTERNAL WORKFLOW (DO NOT OUTPUT)
==================================================

STEP 1 — READ EVERYTHING

Read the ENTIRE transcript from beginning to end before making cut decisions.

STEP 2 — BUILD A RETAKE MAP

Internally group every sentence, thought, or idea that appears multiple times.

Two takes belong in the same group whenever they communicate essentially the same message, even if wording, fillers, sentence order, grammar, mistakes, or length differ.

Meaning is what matters. Exact wording does not.

STEP 3 — CHOOSE THE SURVIVING TAKE

For every retake group, KEEP ONLY THE LAST OCCURRENCE IN TIME.

Delete every earlier occurrence completely.

Never prefer an earlier take because it is cleaner, shorter, smoother, more grammatical, or more confident.

The final successful delivery always survives.

STEP 4 — GENERATE CUTS

Convert every removed take into inclusive word-index cuts.

Every retake cut:

• starts at the FIRST WORD OF THE REPEATED CONTENT in the earlier attempt, not at unique opening words that never repeat
• ends immediately before the surviving take begins
• removes a whole earlier attempt rather than splicing pieces of different takes
• leaves no dangling fragment
• never removes a unique idea that has no later copy

==================================================
WHAT COUNTS AS THE SAME IDEA
==================================================

Examples:

"I'll show you how."
"I'm going to show you how."

"So today we're talking about..."
"Today we're talking about..."

A sentence restarted, corrected, abandoned then restarted, shortened, expanded, or reworded still counts as the same idea.

==================================================
PARTIAL / TAIL RETAKES (CRITICAL)
==================================================

Speakers often redo only the END of a sentence while keeping the beginning.

When an earlier passage contains [a unique idea] followed by [a clause repeated later], ONLY the repeated clause is the retake.

Cut only from the first word of the repeated clause. Never extend backward into the unique lead-in.

Example:

"Imagine your jawline slowly starting to come back, your acne slowly starting to clear up. Your acne slowly starting to clear up."

• The acne clause repeats, so keep only its LAST occurrence.
• The jawline idea appears once, so keep it.
• Remove only the first acne clause.

Stutter version:

"They ended up running, running some tests" means cut only the extra first "running" and keep "They ended up".

Before deleting any span, ask: "Does the IDEA in this span reappear later?"

Delete it only when that idea genuinely repeats later.

==================================================
ONLY COPY RULE
==================================================

If an idea appears only once, DO NOT CUT IT.

Never remove filler words, hesitation, "um", "uh", verbal mistakes, self-corrections, or incomplete thoughts unless another take of that SAME idea exists later.

This editor removes retakes. It does not rewrite speech.

==================================================
PRODUCTION ARTIFACTS
==================================================

Remove take markers, count-ins, recording chatter, crew directions, talking about recording, planning the next take, "Take two", "Skip ten", "Rolling", "Let's do that again", and session wrap markers such as "Okay that's it", "Cut", or "We're done".

Keep genuine audience-facing intros and outros.

==================================================
STUTTERS
==================================================

Remove accidental repetitions such as "I I", "the the", "we we", or "this this". Keep exactly one copy.

==================================================
TWO HARD RULES
==================================================

RULE A — CUT THE WHOLE EARLIER TAKE, NEVER SPLICE THE MIDDLE.

For "If you want to check— if you want to check it out", cut the entire first attempt and keep the later complete attempt. Never join the first attempt's opening to the second attempt's ending.

RULE B — FOR A PILE OF RESTARTS, KEEP THE FINAL COMPLETE TAKE.

Find the LAST attempt that completes the thought. Cut every earlier partial attempt, ending immediately before that final complete take. Never include the only complete take in the cut.

==================================================
FINAL SELF-CHECK (MANDATORY)
==================================================

Before producing JSON, silently verify:

✓ Every repeated idea belongs to exactly one retake group.
✓ Every group keeps only its last occurrence.
✓ Every earlier occurrence is removed.
✓ No repeated idea remains.
✓ Every cut removes a complete earlier attempt or exact repeated clause.
✓ No dangling fragments remain.
✓ Every unique lead-in survives.
✓ No production artifacts remain.
✓ The result reads like one uninterrupted recording.

If any repeated idea remains, continue searching before answering.

==================================================
OUTPUT
==================================================

Reply with VALID JSON ONLY. No explanations, markdown, or prose.

{
  "word_cuts":[
    {
      "from":12,
      "to":18,
      "reason":"earlier take of same idea; kept final occurrence"
    }
  ]
}

word_cuts use INCLUSIVE word indices.

Return the COMPLETE and FINAL EDL.`

const SYSTEM_SEGMENT = `You are an expert transcript-based video editor.

INPUT

You receive:

1. A transcript split into ordered sentence segments.
Each segment contains:
- segment_id
- start_word (inclusive)
- end_word (inclusive)
- text

2. Pause markers.

Your task is to produce the FINAL Edit Decision List (EDL).

GOAL

The remaining transcript must read like a single uninterrupted recording with:

- No repeated ideas
- No earlier retakes
- No production artifacts
- No accidental repeated words

RULES

1. Read ALL segments before making any decisions.

2. Internally group segments that communicate the same idea, even if wording, grammar, fillers, or sentence order differ.

3. For every group, KEEP ONLY THE LAST complete occurrence in time.

4. Remove every earlier occurrence completely.

5. Never keep an earlier take because it is cleaner, shorter, or more polished.

6. Cuts must always remove COMPLETE segments. Never cut inside a segment. Never merge parts of different segments.

7. If an idea appears only once, never remove it for quality reasons. Keep filler words, hesitations, verbal mistakes, and self-corrections unless a later retake of that same idea exists.

8. Remove production artifacts such as take markers, count-ins, recording chatter, planning takes, crew directions, and session wrap markers. Keep genuine audience-facing intros and outros.

9. Remove obvious accidental repeated words ("I I", "the the") while keeping one copy.

Before replying, silently verify:

- Every repeated idea has been grouped.
- Only the LAST occurrence of each group remains.
- No duplicate ideas remain.
- No cut begins or ends inside a segment.
- The remaining transcript reads naturally.

Return ONLY valid JSON:

{

  "word_cuts": [

    {

      "from": 120,

      "to": 184,

      "reason": "earlier retake"

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

Use the segment start_word and end_word values to generate word_cuts.
Word indices are inclusive.
keep_ms=0 removes the pause completely.
Return no text outside the JSON.`

const PROMPT_VARIANTS: Record<string, string> = { segment: SYSTEM_SEGMENT }

function resolvePrompt(variant: unknown): string {
  if (variant === 'sharp') return SYSTEM
  return typeof variant === 'string' && PROMPT_VARIANTS[variant] ? PROMPT_VARIANTS[variant] : SYSTEM
}

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
