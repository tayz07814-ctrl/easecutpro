// EaseCutPro — ProCut (CutCutPro) cloud judge edge function.
//
// Cloud ProCut has no GPT "listening" pass (that stays desktop-only): the
// browser transcribes with AssemblyAI, builds the index-anchored transcript +
// pause map (shared/cutcutpro buildAiPayload) and this function runs Claude as
// the SINGLE finalizer — the SAME verification prompt the desktop pipeline uses
// (src/main/cutcutpro.ts claudeVerifyPass + CLAUDE_VERIFY_SYSTEM), on Haiku
// instead of Opus, given an EMPTY first-pass proposal so it does the full
// analysis itself.
//
// The browser parses `raw` with the SAME validateEdl/refineEdl as the desktop
// path and degrades to "nothing staged" on any problem, so this returns
// { raw: null } rather than erroring whenever the provider misbehaves — the cut
// job always completes. Desktop GPT/whisper code is untouched.
//
// Secret (supabase secrets set): ANTHROPIC_API_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { json, preflight } from '../_shared/http.ts'

// Cloud ProCut finalizer model. Desktop finalizes with Opus; the cloud runs
// Haiku (much faster + cheaper) so its cut quality can be A/B'd against the
// desktop Opus pass. Flip this one line to change the tradeoff.
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

const EDL_SHAPE = `Reply with VALID JSON ONLY (no prose, no markdown fences), exactly:
{"word_cuts":[{"from":12,"to":18,"reason":"earlier take of this line; kept the later one"}],
 "pause_cuts":[{"pause_id":"p3","keep_ms":150,"reason":"dead air; keep a beat"}]}
word_cuts use INCLUSIVE word indices from the list. pause_cuts reference pause ids; keep_ms=0 removes the pause entirely, otherwise that many ms remain.`

// Mirrored from src/main/cutcutpro.ts CLAUDE_VERIFY_SYSTEM (keep in sync). In the
// cloud path the proposal is always empty, so the "perform the full analysis
// yourself" clause makes Claude do the whole cut from the transcript map.
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

async function claudeFinalize(key: string, payload: string, proposal: unknown): Promise<string> {
  const userText =
    `${payload}\nFIRST-PASS PROPOSED EDL:\n${JSON.stringify(proposal)}\n\nVerify it, guarantee ZERO repeats remain (keep the LAST take of every duplicate), keep the kept script coherent, and return the final EDL.`
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      // 8k is ample for the EDL (a small JSON) and stays under Haiku's output
      // ceiling; the desktop Opus pass uses 16k but never needs it here.
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }]
    })
  })
  if (!r.ok) throw new Error(`Anthropic: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const d = (await r.json()) as { content: { type: string; text?: string }[] }
  return d.content.map((b) => b.text ?? '').join('')
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    if (!(await requireUser(req))) return json({ error: 'Not signed in' }, 401)
    const { payload, proposal } = await req.json().catch(() => ({ payload: null, proposal: null }))
    if (typeof payload !== 'string' || !payload) return json({ error: 'missing payload' }, 400)

    const anthropic = Deno.env.get('ANTHROPIC_API_KEY')
    if (!anthropic) return json({ raw: null, judge: 'none' })
    try {
      return json({ raw: await claudeFinalize(anthropic, payload, proposal ?? { word_cuts: [], pause_cuts: [] }), judge: 'anthropic:claude-haiku' })
    } catch (e) {
      console.warn('[procut-judge] anthropic failed:', (e as Error).message)
      return json({ raw: null, judge: 'anthropic:claude-haiku' })
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
