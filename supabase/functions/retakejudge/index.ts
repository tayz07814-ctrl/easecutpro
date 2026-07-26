// EaseCutPro — dedicated Retake judge.
//
// Preserves UltraCut's proven retake prompt and streaming behavior while removing
// every model experiment. One request always goes to Gemma 4 31B on OpenRouter.

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

const BASE_SYSTEM = `You are a professional transcript-based video editing AI.

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

const SHARP_ANCHOR = `==================================================
FINAL SELF-CHECK (MANDATORY)`

const SHARP_RULES = `==================================================
TWO HARD RULES (MOST COMMON MISTAKES — OBEY EXACTLY)
==================================================

RULE A — CUT THE WHOLE EARLIER TAKE, NEVER SPLICE THE MIDDLE.
When a sentence is restarted, e.g. "If you want to check— if you want to check it out":
- The retake cut MUST start at the FIRST word of the earlier take and end right before the later take begins.
- CORRECT: cut "If you want to check—" (the entire first attempt). Keep "if you want to check it out...".
- WRONG: cutting only "check— if you want to" (the middle) — that splices the first take's opening onto the second take's ending. NEVER do this. Always remove a WHOLE earlier take, never a middle slice that joins two takes.

RULE B — A PILE OF RESTARTS: KEEP THE FINAL COMPLETE TAKE, CUT EVERYTHING BEFORE IT.
When the SAME sentence is attempted many times in a row (a long pile of false starts, often "literally... literally... literally..."):
- Find the LAST attempt that finishes the complete thought.
- Cut ALL earlier partial attempts as one span, ENDING right before that final complete take.
- KEEP the final complete take in full. It is the ONLY good copy — NEVER include it in the cut.
- Example: many "literally people who..." restarts ending in "literally people who inject tons of glutathione straight into their veins." -> cut everything up to the last "literally" that begins the complete sentence; KEEP "literally people who inject tons of glutathione straight into their veins."

`

const SYSTEM = BASE_SYSTEM.replace(SHARP_ANCHOR, SHARP_RULES + SHARP_ANCHOR)

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
    await admin().rpc('log_delta_debug', { payload: { judge: 'retakejudge', ...fields } })
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
        'X-Title': 'EaseCutPro Retake Judge'
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
      /* non-JSON body */
    }
  }
  const cleaned = extractEdl(content)

  await logDebug({
    model: MODEL,
    provider: 'openrouter',
    http_status: response.status,
    ok: response.ok,
    content_len: content.length,
    cleaned_len: cleaned.length,
    content_snippet: content.slice(0, 3000),
    err_body: response.ok ? null : bodyText.slice(0, 2000),
    req_payload: payload.slice(0, 16000)
  })

  if (!response.ok || !cleaned) throw new Error(`OpenRouter request failed (HTTP ${response.status})`)
  return cleaned
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf

  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const { payload } = await req.json().catch(() => ({ payload: null }))
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)

    const apiKey = await getApiKey()
    if (!apiKey) return json({ raw: null, judge: 'none' })

    // Preserve UltraCut's whitespace keep-alive so long model calls do not hit
    // Supabase's idle timeout. JSON permits leading whitespace before the object.
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const beat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(' '))
          } catch {
            /* stream closed */
          }
        }, 20_000)

        let out: unknown
        try {
          out = { raw: await judge(apiKey, payload), judge: `retakejudge:${MODEL}` }
        } catch (error) {
          console.warn('[retakejudge] OpenRouter Gemma request failed:', (error as Error).message)
          out = { raw: null, judge: `retakejudge:${MODEL}` }
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

    return new Response(stream, {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return json({ error: (error as Error).message }, 500)
  }
})

