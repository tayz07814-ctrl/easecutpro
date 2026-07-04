/**
 * AI cut suggestions (optional; opt-in).
 *
 * Given a word-timestamped transcript, ask gpt-5 or claude-4-8-opus which spans are
 * removable — filler words, stutters/false starts, repeated retakes (keep the
 * last good take, cut the earlier ones), and dead rambling. Returns word ids to
 * cut, each with a reason. This is the semantic upgrade over the local regex
 * heuristics in src/shared/fillers.ts.
 *
 * Runs in the main/server process where the API key lives; the renderer reaches it via IPC / HTTP.
 */
import { getOpenAI } from './openai'
import { claudeAvailable } from './claude'
import { requestCutsClaudeBracket } from './cut-claude'
import type { Transcript, AICut, AICutResult } from '../shared/types'

type ProgressFn = (pct: number, msg?: string) => void

// GPT-5: frontier reasoning model, far better at the repeat/retake judgment than
// gpt-4o AND cheaper. Note it's a reasoning model — no `temperature`/`max_tokens`;
// behavior is controlled via `reasoning_effort` instead.
const CUT_MODEL = 'gpt-5'
const WINDOW = 500 // words per request
const OVERLAP = 40 // word overlap so a retake spanning a boundary is still seen

const SYSTEM_PROMPT = `You are the cut-suggestion engine for a transcript-based video editor (talking-head / spoken videos). You receive a numbered list of words from ONE speaker. Find spans of words to REMOVE so the final video is tight and clean, while preserving every unique idea. Output ONLY cuts; never rewrite the transcript.

Be PRECISE, not aggressive. Remove only what is clearly redundant; preserve the message. When you are unsure whether something is redundant, KEEP it — removing real content is worse than leaving one repeat in.

Cut these kinds of spans:
- "stutter": a word or short phrase repeated back-to-back ("the the", "to to", "I I", "all I all I", "show you show you", "because because"). Keep EXACTLY ONE copy (never zero). This is just the doubled phrase — do NOT extend the cut into the rest of the sentence.
- "repeat" (re-recorded take): the speaker attempts the SAME sentence two or more times in a row to fix a flub, then lands a clean version. KEEP ONLY the LAST complete take; cut EVERY earlier attempt — including the very first abandoned fragment and any lead-in — as ONE contiguous span that ends right before the final take begins. So for "One of the most power… one of the most… one of the most powerful X", cut everything before the final "one of the most powerful X" (leave NO leading fragment). Takes may differ in wording — judge by MEANING. Never cut the final take, and never leave a dangling fragment of an earlier take.
- "filler": hesitations / fillers that carry no meaning (um, uh, er, ah, hmm, like, you know, I mean, basically, actually-as-filler). Cut only when the meaning is unchanged.
- "ramble": an obvious dead tangent that goes nowhere. Be conservative — never cut useful explanation, examples, or new facts.

Rules:
- Precision over recall: flag only clear redundancy; when in doubt, KEEP the content. Do NOT cut a whole sentence just because part of it repeats — cut only the redundant part.
- A repeat is the SAME thought delivered again BACK-TO-BACK (only filler/hesitation between). Sentences that share an opening phrase but then make DIFFERENT points are NOT repeats — keep them all. Example: "but most importantly it helps restore your skin… but most importantly it helps strengthen… but most importantly it helps your barrier" are THREE different points — keep all three; only collapse a truly doubled phrase like "but most importantly, but most importantly" to one.
- When a sentence IS genuinely re-recorded, keep the LAST complete take and remove every earlier attempt as one span — leaving no fragment behind.
- "text" MUST be the exact words removed, copied VERBATIM from the list in order; [start,end] and "text" must point to the SAME words — check the index beside each word.
- "kind" is one of "stutter", "repeat", "filler", "ramble". "reason" is a short phrase. Cuts must not overlap and must stay in ascending order; every remaining sentence must read naturally after cuts are applied.
Return the object { "cuts": [...] }.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cuts'],
  properties: {
    cuts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'text', 'kind', 'reason'],
        properties: {
          start: { type: 'integer', description: 'first word index to remove (inclusive)' },
          end: { type: 'integer', description: 'last word index to remove (inclusive)' },
          text: {
            type: 'string',
            description: 'The EXACT word stream being extracted, copied verbatim from the text list. Crucial: Extract text stream first, then populate exact start and end indices matching it.'
          },
          kind: { type: 'string', enum: ['repeat', 'stutter', 'filler', 'ramble'] },
          reason: { type: 'string' }
        }
      }
    }
  }
} as const

const BRACKET_PROMPT = `You are an expert audio transcription editor for a talking-head video editor. Your task is to analyze raw voice-to-text transcripts that contain verbal stumbles, false starts, and repeated phrases (multiple "takes" of the same sentence), and produce a cleaned-up version using strict bracketing rules.

### Definitions:
1. "False Start / Stumble / Repetition": Any word, fragment, or full sentence that the speaker abandons or repeats because they are trying to deliver a cleaner version of that same thought.
2. "Final Clean Take": The last, most complete, and grammatically successful utterance of a phrase or sentence before the speaker moves on to a completely new thought.

### Instructions:
- Read through the text sequentially. Identify every instance where a speaker restarts a phrase or repeats a sentence.
- Place all abandoned attempts, stumbles, fragments, and identical/near-identical repeated sentences inside square brackets [...].
- Keep ONLY the final, clearest, and chronologically latest "take" outside of the brackets.
- Ensure that if an entire introductory thought is repeated or rephrased seamlessly later, the earlier redundant version is bracketed out.
- Sentences that merely share an opening phrase but then make DIFFERENT points are NOT repeats — keep them ALL outside brackets. Only bracket genuine re-takes of the SAME thought.
- Do not paraphrase, summarize, or fix grammar outside of separating the takes. Every single word from the raw text must be accounted for — either inside a bracket or outside as part of the final clean stream.

### Critical guardrails (DO NOT over-bracket):
- NEVER bracket the final, complete version of a thought. Only the EARLIER abandoned attempts of the SAME thought go inside brackets; the last good version always stays outside.
- A sentence that adds a NEW point, benefit, fact, example, or detail is its OWN clean take — KEEP it outside brackets even if it begins with the same words as a previous sentence. Example: "But most importantly it helps strengthen. But most importantly it helps restore your skin barrier." → two DIFFERENT benefits (strengthen vs restore the barrier) → bracket NEITHER sentence (only a literally doubled "but most importantly, but most importantly" collapses to one).
- If two consecutive sentences name a DIFFERENT object, benefit, action, or outcome, they are DIFFERENT points — keep BOTH, even when one sounds short or unfinished. Only bracket an earlier attempt when the later sentence restates the SAME object/outcome more cleanly.
- When the speaker restarts the SAME opening phrase several times and only the LAST run continues into a full sentence, bracket ONLY the abandoned runs and keep the entire final run INCLUDING its repeated opening words. Example: "one of the most, one of the most, one of the most powerful X" → bracket "one of the most, one of the most," and keep the full "one of the most powerful X" (never strip the opening words off the surviving take).
- A single bracket must NEVER span from one thought into a DIFFERENT thought. Each bracket wraps only the abandoned version of ONE thought.
- When unsure whether two sentences are the same thought re-taken vs two different thoughts, treat them as DIFFERENT and keep BOTH. Under-bracketing is far better than cutting real content.

### Output:
Return ONLY the transcript text, verbatim, with square brackets inserted — no preamble, no explanation, no numbering, no nesting.
CRITICAL — verbatim echo: Do NOT retype, rewrite, re-spell, re-punctuate, "clean up", or DUPLICATE any words. Your output must be the EXACT input character stream with ONLY '[' and ']' characters added. Never write a word that is not already in the input, and never make a second copy of a phrase to use as the clean take — if the final take reuses opening words (like "one of the most"), those words already exist once in the input as the START of the final run, so simply leave the bracket BEFORE them. Every input word appears exactly once in your output; the only difference between input and output is the bracket characters.`

/** 
 * Pull each bracketed `[…]` span out of Claude's reply as a cut to anchor. 
 * Context Aware: Estimates the index position inside the window based on string index ratio 
 * so that resolveSpan doesn't accidentally latch onto a different identical word earlier in the window.
 */
function parseBrackets(bracketed: string, windowStart: number, plainLength: number): RawCut[] {
  const out: RawCut[] = []
  const re = /\[([^[\]]+)\]/g
  let m: RegExpExecArray | null
  
  while ((m = re.exec(bracketed)) !== null) {
    const seg = (m[1] || '').trim()
    if (!toks(seg).length) continue
    
    // Fallback alignment anchor logic: determine roughly where inside the text window this bracket sits
    const matchIndex = m.index
    const ratio = plainLength > 0 ? matchIndex / plainLength : 0
    const estimatedLocalOffset = Math.floor(ratio * WINDOW)
    const estimatedGlobalIndex = windowStart + estimatedLocalOffset

    out.push({ 
      start: estimatedGlobalIndex, 
      end: estimatedGlobalIndex, 
      text: seg, 
      kind: 'repeat', 
      reason: 're-take / false start' 
    })
  }
  return out
}

export interface RawCut {
  start: number
  end: number
  text: string
  kind: AICut['kind']
  reason: string
}

/** Normalize a single word for matching (lowercase, strip non-alphanumeric). */
const tok1 = (s: string): string => s.toLowerCase().replace(/[^a-z0-9']/g, '')
/** Tokenize a phrase into normalized words. */
const toks = (s: string): string[] => s.split(/\s+/).map(tok1).filter(Boolean)

/**
 * Resolve a model cut to a concrete [start,end] word range, ANCHORED to the
 * verbatim text it claims to remove. The model's indices are a hint only —
 * over a flat list with repeated words ("all I all I") it miscounts. So:
 *    1. if the hinted span's words already match the claimed text, use it;
 *    2. else search the window for the claimed words and snap to the nearest;
 *    3. else (text not found) DROP the cut — never slice unrelated words.
 * Returns [s,e] inclusive, or null to skip.
 */
function resolveSpan(
  words: { text: string }[],
  a: number,
  b: number,
  c: RawCut
): [number, number] | null {
  const want = toks(c.text || '')
  if (!want.length) return null

  const hs = Math.max(a, Math.min(b - 1, Math.floor(Number(c.start))))
  const he = Math.max(hs, Math.min(b - 1, Math.floor(Number(c.end))))

  const hinted = words.slice(hs, he + 1).map((w) => tok1(w.text)).filter(Boolean)
  if (hinted.length === want.length && hinted.every((t, k) => t === want[k])) return [hs, he]

  // Relocate: find every contiguous span in [a,b) whose words match `want`.
  const L = want.length
  const found: number[] = []
  for (let i = a; i + L <= b; i++) {
    let ok = true
    for (let k = 0; k < L; k++) {
      if (tok1(words[i + k].text) !== want[k]) {
        ok = false
        break
      }
    }
    if (ok) found.push(i)
  }
  if (!found.length) return null
  
  // Pivot matching strategy: find the occurrence closest to our targeted estimation point (hs)
  found.sort((p, q) => Math.abs(p - hs) - Math.abs(q - hs))
  return [found[0], found[0] + L - 1]
}

/**
 * If a cut span STARTS with a unit that repeats immediately after it, the model
 * over-cut into a repeated phrase. Trim the cut to just that FIRST unit so one
 * clean copy always survives (keeps the last take). Handles any unit length and
 * any span the model picked: "all I all I" or a loose "all I all" both -> cut
 * "all I", keep "all I do…". Leaves non-repeating cuts (fillers, failed takes
 * with different wording) untouched.
 */
function keepOneCopy(words: { text: string }[], s: number, e: number): [number, number] {
  const n = words.length
  const span = e - s + 1
  for (let u = 1; u <= span; u++) {
    if (s + 2 * u > n) break // not enough words for a second copy of this unit
    let dup = true
    for (let k = 0; k < u; k++) {
      if (tok1(words[s + k].text) !== tok1(words[s + u + k].text)) {
        dup = false
        break
      }
    }
    if (dup) return [s, s + u - 1]
  }
  return [s, e]
}

/** Suggest cuts for a transcript. */
export async function suggestCutsAI(
  transcript: Transcript,
  onProgress?: ProgressFn
): Promise<AICutResult> {
  const words = transcript.words
  const n = words.length
  if (n === 0) return { ids: [], cuts: [] }

  // System falls back to high-reasoning OpenAI GPT-5 pipelines if Claude credentials aren't deployed
  const useClaude = claudeAvailable()
  const openai = useClaude ? null : getOpenAI()

  const step = Math.max(1, WINDOW - OVERLAP)
  const windows: { a: number; b: number }[] = []
  for (let a = 0; a < n; a += step) windows.push({ a, b: Math.min(n, a + WINDOW) })

  let done = 0
  const rawByWindow = await mapLimit(windows, 4, async (w) => {
    let raw: RawCut[]
    if (useClaude) {
      const plain = words.slice(w.a, w.b).map((x) => x.text).join(' ')
      const bracketedResult = await requestCutsClaudeBracket(plain, BRACKET_PROMPT)
      raw = parseBrackets(bracketedResult, w.a, plain.length)
    } else {
      const numbered = words.slice(w.a, w.b).map((x, k) => `${w.a + k}\t${x.text}`).join('\n')
      raw = await requestCuts(openai!, numbered)
    }
    done++
    onProgress?.(Math.round((done / windows.length) * 100), `Analyzed ${done}/${windows.length}`)
    return raw
  })

  // Apply results in window order (keeps the overlap-dedup deterministic).
  const covered = new Set<string>()
  const cuts: AICut[] = []
  for (let wi = 0; wi < windows.length; wi++) {
    const { a, b } = windows[wi]
    for (const c of rawByWindow[wi] ?? []) {
      const span = resolveSpan(words, a, b, c)
      if (!span) continue // claimed text not found -> don't cut unrelated words
      
      // Bracketed spans from Claude 3.5 Sonnet pinpoint the specific abandoned phrase—keepOneCopy
      // is bypassed to preserve long non-identical retakes.
      const [s, e] = useClaude ? span : keepOneCopy(words, span[0], span[1])
      const slice = words.slice(s, e + 1)
      const ids = slice.map((w) => w.id).filter((id) => !covered.has(id))
      if (ids.length === 0) continue
      
      ids.forEach((id) => covered.add(id))
      cuts.push({
        ids,
        kind: c.kind,
        reason: c.reason || c.kind,
        text: slice.map((w) => w.text).join(' ')
      })
    }
  }

  return { ids: [...covered], cuts }
}

/** Run an async fn over items with a concurrency cap; preserves input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker))
  return results
}

async function requestCuts(
  openai: ReturnType<typeof getOpenAI>,
  numbered: string
): Promise<RawCut[]> {
  const res = await openai.chat.completions.create(
    {
      model: CUT_MODEL,
      reasoning_effort: 'low', // GPT-5 reasoning control — 'low' is plenty here and much faster
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: numbered }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'cuts', strict: true, schema: SCHEMA }
      }
    },
    { timeout: 120_000 } // never hang a window forever
  )
  const content = res.choices[0]?.message?.content
  if (!content) return []
  try {
    const parsed = JSON.parse(content) as { cuts?: RawCut[] }
    return Array.isArray(parsed.cuts) ? parsed.cuts : []
  } catch {
    return []
  }
}