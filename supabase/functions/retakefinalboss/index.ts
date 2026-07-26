// EaseCutPro 0.07 — Retake Final Boss judge.
// Fixed OpenRouter Gemma path. Input is only indexed AssemblyAI verbatim words;
// output is only inclusive word cuts. Silence is handled later on-device.

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = 'google/gemma-4-31b-it'
const MODEL_BUDGET_MS = 340_000

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

async function getApiKey(): Promise<string> {
  const key = Deno.env.get('OPEN_ROUTER_KEY')
  if (key) return key
  try {
    const { data } = await admin().rpc('delta_judge_key')
    if (typeof data === 'string' && data) return data
  } catch {
    /* vault not configured */
  }
  return ''
}

function extractEdl(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const object = text.match(/\{[\s\S]*\}/)
  return (object ? object[0] : text).trim()
}

// Preserves the Retake judge's proven whole-take, last-take, only-copy, partial-
// tail, production-artifact, and stutter rules. All silence/predicted-boundary
// input and output instructions are deliberately absent.
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

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await client.auth.getUser()
  return !!data.user
}

async function logDebug(fields: Record<string, unknown>): Promise<void> {
  try {
    await admin().rpc('log_delta_debug', { payload: { judge: 'retakefinalboss', ...fields } })
  } catch {
    /* diagnostics must never fail a cut */
  }
}

async function judge(apiKey: string, payload: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODEL_BUDGET_MS)
  let response: Response
  try {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://easecutpro.com',
        'X-Title': 'EaseCutPro Retake Final Boss'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 20_000,
        stream: false,
        reasoning: { effort: 'low' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: payload }
        ]
      }),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }

  const bodyText = await response.text()
  let content = ''
  if (response.ok) {
    try {
      content = (JSON.parse(bodyText) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? ''
    } catch {
      /* non-JSON response */
    }
  }
  const cleaned = extractEdl(content)
  await logDebug({
    model: MODEL,
    provider: 'openrouter',
    http_status: response.status,
    ok: response.ok,
    content_len: content.length,
    content_snippet: content.slice(0, 3000),
    req_payload: payload.slice(0, 16000)
  })
  if (!response.ok || !cleaned) throw new Error(`OpenRouter request failed (HTTP ${response.status})`)
  return cleaned
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const { payload } = await req.json().catch(() => ({ payload: null }))
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)

    const apiKey = await getApiKey()
    if (!apiKey) return json({ raw: null, judge: 'none' })

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const beat = setInterval(() => {
          try { controller.enqueue(encoder.encode(' ')) } catch { /* closed */ }
        }, 20_000)
        let output: unknown
        try {
          output = { raw: await judge(apiKey, payload), judge: `retakefinalboss:${MODEL}` }
        } catch (error) {
          console.warn('[retakefinalboss] judge failed:', (error as Error).message)
          output = { raw: null, judge: `retakefinalboss:${MODEL}` }
        } finally {
          clearInterval(beat)
          try { controller.enqueue(encoder.encode(JSON.stringify(output))) } catch { /* closed */ }
          try { controller.close() } catch { /* closed */ }
        }
      }
    })
    return new Response(stream, { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    return json({ error: (error as Error).message }, 500)
  }
})
