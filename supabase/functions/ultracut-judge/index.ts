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

const BASE_URL = Deno.env.get('ULTRACUT_BASE_URL') ?? 'https://openrouter.ai/api/v1'
const MODEL = Deno.env.get('ULTRACUT_MODEL') ?? 'google/gemma-4-31b-it'

const DEEPSEEK_BASE_URL = Deno.env.get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com'
const DEEPSEEK_DIRECT = new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat'])

const MODEL_WHITELIST = new Set([
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-luna-pro',
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

The remaining transcript must read exactly like one continuous recording. Accuracy is more important than minimizing cuts.

==================================================
INTERNAL WORKFLOW (DO NOT OUTPUT)
==================================================
STEP 1 — READ EVERYTHING
Read the ENTIRE transcript from beginning to end before making cut decisions. Watch out for "Late Pickups," where a speaker re-records an introduction or conclusion at the very end of the file.

STEP 2 — BUILD A RETAKE MAP
Internally group every sentence, thought, or idea that appears multiple times. Exact wording does not matter; meaning matters.

STEP 3 — CHOOSE THE SURVIVING TAKE
For every retake group, KEEP ONLY THE LAST OCCURRENCE IN TIME. Delete every earlier occurrence completely.

STEP 4 — GENERATE CUTS
Convert every removed take into inclusive word-index cuts. 
• Cuts start at the FIRST WORD OF THE REPEATED CONTENT.
• Cuts end immediately before the surviving take begins.
• Cuts must completely swallow any dangling fragments, hyphens, or hanging words (e.g., "it smells—") from the abandoned attempt.

==================================================
CRITICAL RULES
==================================================

RULE 1: THE ONLY COPY RULE (UNIQUE IDEAS SURVIVE)
If an idea appears only once, DO NOT CUT IT. If an earlier take contains [Idea A + Idea B], but the later retake only contains [Idea B], you MUST preserve [Idea A]. Never cut a unique lead-in.

RULE 2: NO DANGLING FRAGMENTS
When you cut an abandoned thought, do not leave a single hanging word behind. 

RULE 3: WHOLE TAKES, NO SPLICING
Cut the entire earlier attempt and keep the later complete attempt. Never join the first attempt's opening to the second attempt's ending.

RULE 4: PRODUCTION ARTIFACTS
Remove take markers, counting, recording chatter, and instructions to the editor (e.g., "you can start there", "cut the middle").

==================================================
OUTPUT FORMAT
==================================================
Reply with VALID JSON ONLY. No markdown, no prose, no explanations. 

Your JSON must exactly match this structure:
{
  "word_cuts": [
    {
      "from": 0,
      "to": 5,
    }
  ],
}

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

// VARIATIONS — a different job from the retake judge above. Nothing is being
// removed here: the model RE-ORDERS the recording into short-form cuts, selecting
// sections by word index. Indices only; the client owns the timestamps.
const SYSTEM_VARIATIONS = `You are a short-form video editor. You receive a verbatim transcript with immutable word indices.

Your job is to CAST the recording into short-form edits by selecting sections and putting them in a new order. You are not removing mistakes and you are not rewriting anything — you are choosing the best moments and sequencing them.

==================================================
SECTION ROLES
==================================================
• hook    — the single most attention-grabbing line in the whole transcript
• intro   — who the speaker is / what this is about
• problem — the pain, frustration or need being described
• selling — the product, solution, benefit or proof
• cta     — the closing ask (subscribe, link, buy, try it)

==================================================
RULES
==================================================
1. Reference the transcript ONLY by word index. "from" and "to" are inclusive.
2. Pull sections from ANY part of the transcript, in ANY order. Re-ordering is the entire point — the hook very often comes from the middle or the end.
3. Every section must be a COMPLETE thought: begin at the first word of a sentence and end at the last word of a sentence. NEVER start or stop mid-sentence.
4. Each variation is 4–6 sections and roughly 15–45 seconds of speech.
5. Variations must be MEANINGFULLY different from each other — a different hook, or a genuinely different running order. Do not return near-duplicates that differ by a word or two.
6. Include hook and cta whenever the transcript contains anything that can serve as one. Skip a role only if the recording genuinely has nothing for it.
7. Give each variation a short descriptive name of what makes it different (e.g. "Problem First", "Testimonial Lead").

==================================================
OUTPUT FORMAT
==================================================
Reply with VALID JSON ONLY. No markdown, no prose, no explanation.

{
  "variations": [
    {
      "name": "Hook First",
      "sections": [
        { "role": "hook", "from": 412, "to": 447 },
        { "role": "intro", "from": 18, "to": 39 },
        { "role": "problem", "from": 40, "to": 71 },
        { "role": "selling", "from": 210, "to": 268 },
        { "role": "cta", "from": 448, "to": 461 }
      ]
    }
  ]
}

Return exactly the number of variations requested.`

const PROMPT_VARIANTS: Record<string, string> = { segment: SYSTEM_SEGMENT, variations: SYSTEM_VARIATIONS }

function resolvePrompt(variant: unknown): string {
  if (variant === 'sharp') return SYSTEM
  return typeof variant === 'string' && PROMPT_VARIANTS[variant] ? PROMPT_VARIANTS[variant] : SYSTEM
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
    // Auth + payload cap + one AI credit, charged BEFORE the model call.
    const g = await gate(req, 1)
    if (!g.ok) return g.res

    const { payload, model: requestedModel, promptVariant, reasoning } = g.ctx.body

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
