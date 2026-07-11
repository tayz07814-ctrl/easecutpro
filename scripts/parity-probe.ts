// Retake β parity probe — DIAGNOSTIC ONLY (does not change any engine).
//
// Reproduces, for one known transcript, the three judge paths and logs every
// field needed to locate where parity is lost vs a plain Haiku chat test:
//
//   TEST A  — raw untouched transcript -> Haiku, simple instruction (chat twin)
//   TEST B1 — CURRENT CLOUD production: FULL buildAiPayload -> Opus (procut-judge
//             prompt) -> validateEdl -> refineEdl -> word ids   (LLM-first)
//   TEST B2 — desktop / old-cloud: rules-first FILTERED candidates + 12k context
//             -> Haiku (classifier prompt) -> parseLlmDecisions  (rules-first)
//
// Offline (no key): logs exactly what each path WOULD send (transcript text,
// payload, candidate filtering, prompts, sizes) — answers Q1/Q3/Q4.
// Live  (ANTHROPIC_API_KEY set): also calls the models and logs response,
// stop_reason, tokens, parsed decisions, mapping, final cut spans — Q2/Q5/Q7.
//
//   tsx scripts/parity-probe.ts <fixture-name>
//
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  buildChunks,
  detectFillers,
  findRetakeGroups,
  extendProgressiveRetakes,
  detectProductionChatter,
  spansToWordIds
} from '../src/shared/retakeaware/analyze'
import { parseLlmDecisions } from '../src/shared/retakeaware/engine'
import {
  buildTimestampMap,
  buildAiPayload,
  validateEdl,
  refineEdl,
  type Edl,
  type TimestampMap
} from '../src/shared/cutcutpro'
import type { VerbatimTranscript, CutSpan } from '../src/shared/retakeaware/types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX = join(__dirname, '..', 'test-fixtures', 'retake-aware')
const name = process.argv[2] || 'behind-scenes-blooper'

// ---- exact production prompts (copied verbatim; keep in sync if they change) --
const SIMPLE_INSTRUCTION_A =
  `You are helping edit a raw video transcript. Identify the parts that should be CUT from the final video:\n` +
  `- retakes (repeated attempts at the same line — keep the last good one)\n` +
  `- self-talk / self-correction ("wait no", "let me say that again")\n` +
  `- production chatter (talking about the shoot, not to the audience)\n` +
  `- directions / instructions between creators ("you say this, then I'll say that")\n` +
  `List each cut as the exact text + a short reason. Keep all real audience-facing content.`

// procut-judge SYSTEM (cloud production Retake β after the ProCut-style switch)
const PROCUT_EDL_SHAPE = `Reply with VALID JSON ONLY (no prose, no markdown fences), exactly:
{"word_cuts":[{"from":12,"to":18,"reason":"earlier take of this line; kept the later one"}],
 "pause_cuts":[{"pause_id":"p3","keep_ms":150,"reason":"dead air; keep a beat"}]}
word_cuts use INCLUSIVE word indices from the list. pause_cuts reference pause ids; keep_ms=0 removes the pause entirely, otherwise that many ms remain.`
const PROCUT_SYSTEM = `You are the SECOND PASS (verification + finalization) of a professional video cutting pipeline. GOAL: after your cuts the kept transcript must contain ZERO repeated sentences/lines and read as one coherent script. You receive the index-anchored VERBATIM transcript map and the FIRST PASS's proposed EDL.

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

${PROCUT_EDL_SHAPE}`

// classifier SYSTEM (desktop llm.ts + old cloud llm-judge; rules-first path)
const CLASSIFIER_SYSTEM = `You review video-editing candidates for a talking-head editor. You get retake groups (repeated attempts at the same line) and filler-word candidates.
Rules:
- For each retake group pick exactly ONE keep_attempt from the listed attempt_ids. NEVER combine words from different attempts.
- Prefer the most complete, fluent, latest attempt.
- ABANDONED / FALSE starts ARE retakes: if an attempt breaks off mid-thought it is a flub — affirm the group, keep the completed attempt, put every broken fragment in remove_attempts.
- You may ALSO receive "productionChatterCandidates": ambiguous phrases that might be PRODUCTION CHATTER rather than AUDIENCE-DIRECTED content. For each return cut | keep | needs_review by candidate_id.
Reply with ONLY a JSON object: {"retake_group_decisions":[...],"filler_decisions":[...],"production_chatter_decisions":[...]} — no prose, no markdown fences.`
// (B2 uses the FULL prompt in production; abbreviated here only for the log —
//  the live B2 call below loads the exact one from src/main/retakeaware/llm.ts.)

// ---------------------------------------------------------------------------
const vt = JSON.parse(readFileSync(join(FIX, `${name}.words.json`), 'utf8')) as VerbatimTranscript & { clean_text?: string }
const rawText = vt.clean_text?.trim() || vt.words.map((w) => w.word).join(' ')
const line = (n = 72): string => '─'.repeat(n)

console.log(`\n${'='.repeat(72)}\nRETAKE β PARITY PROBE — fixture: ${name}\n${'='.repeat(72)}`)
console.log(`transcript: ${vt.words.length} words, ${rawText.length} chars, provider=${vt.provider}`)

// ---- Build every path's OUTGOING payload (offline; no key needed) ----------
// TEST A user message
const userA = `${rawText}`

// TEST B1 (cloud): full index-anchored transcript, empty first-pass proposal
const map: TimestampMap = buildTimestampMap(
  vt.words.map((w, i) => ({ id: `w${i}`, text: w.word, start: w.start, end: w.end })),
  []
)
const payloadB1 = buildAiPayload(map)
const userB1 = `${payloadB1}\nFIRST-PASS PROPOSED EDL:\n${JSON.stringify({ word_cuts: [], pause_cuts: [] })}\n\nVerify it, guarantee ZERO repeats remain (keep the LAST take of every duplicate), keep the kept script coherent, and return the final EDL.`

// TEST B2 (rules-first): the EXACT ReviewPayload the engine sends (filtered)
const chunks = buildChunks(vt)
const fillerCandidates = detectFillers(vt.words)
const fillerDecisions = fillerCandidates.map((f) => ({ ...f }))
const { groups } = findRetakeGroups(chunks, vt.words, fillerDecisions)
extendProgressiveRetakes(chunks, groups, vt.words, fillerDecisions)
const chatterCandidates = detectProductionChatter(chunks, vt.words, groups)
const ambiguousChatter = chatterCandidates.filter((c) => c.decision === 'needs_review')
const context = chunks.map((c) => `[${c.id}] ${c.text}`).join('\n').slice(0, 12000)
const ambiguousFillers = fillerDecisions.filter((f) => f.classification === 'keep' || f.classification === 'shorten')
const reviewPayload = {
  transcriptContext: context,
  retakeGroups: groups,
  fillerCandidates: ambiguousFillers,
  editingStyle: 'natural talking-head; keep conversational fillers unless ugly',
  productionChatterCandidates: ambiguousChatter
}
const userB2 = JSON.stringify(reviewPayload)

// ---- OFFLINE REPORT (Q1, Q3, Q4) -------------------------------------------
console.log(`\n${line()}\nOUTGOING PAYLOADS — what each path actually sends\n${line()}`)
console.log(`TEST A   model=claude-haiku-4-5-20251001  system=SIMPLE(${SIMPLE_INSTRUCTION_A.length}c)  user=RAW transcript (${userA.length}c, ${vt.words.length} words)`)
console.log(`TEST B1  model=claude-opus-4-8            system=PROCUT-EDL(${PROCUT_SYSTEM.length}c)  user=FULL indexed transcript (${userB1.length}c, ${map.words.length} words)`)
console.log(`TEST B2  model=claude-haiku-4-5-20251001  system=CLASSIFIER(${CLASSIFIER_SYSTEM.length}c+)  user=FILTERED candidates JSON (${userB2.length}c)`)
console.log(`\nRules-first FILTERING (what B2 hides from the model):`)
console.log(`  retake groups sent .......... ${groups.length}`)
console.log(`  provisional (LLM-gated) ..... ${groups.filter((g) => g.provisional).length}`)
console.log(`  ambiguous fillers sent ...... ${ambiguousFillers.length} / ${fillerCandidates.length} detected`)
console.log(`  chatter candidates: total ... ${chatterCandidates.length}  (sent to LLM: ${ambiguousChatter.length} needs_review; ${chatterCandidates.length - ambiguousChatter.length} decided by RULES, never sent)`)
console.log(`  transcriptContext ........... ${context.length}c ${context.length >= 12000 ? '⚠ TRUNCATED at 12000' : '(full)'}`)
console.log(`  → B2 sends the model NONE of the raw transcript verbatim — only rule-flagged candidates + a capped context snippet.`)
console.log(`  → If the rules flag nothing, llm.ts returns early and the model is NEVER CALLED (see llm.ts:107).`)

// ---- LIVE CALLS (Q2, Q5, Q7) — only if a key is present --------------------
const KEY = process.env.ANTHROPIC_API_KEY
if (!KEY) {
  console.log(`\n${line()}\nLIVE TESTS SKIPPED — no ANTHROPIC_API_KEY in env.\nSet it and re-run to capture responses / stop_reason / tokens / parsed decisions.\n${line()}\n`)
  process.exit(0)
}

// dynamic import so the offline path needs no SDK resolution
const Anthropic = (await import('@anthropic-ai/sdk')).default
const client = new Anthropic({ apiKey: KEY })

async function call(tag: string, model: string, system: string, user: string, maxTokens: number): Promise<string> {
  console.log(`\n${line()}\n${tag}  (model=${model}, max_tokens=${maxTokens})\n${line()}`)
  const res = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
  const text = res.content.map((b) => ('text' in b ? b.text : '')).join('')
  console.log(`stop_reason=${res.stop_reason}  in=${res.usage.input_tokens}  out=${res.usage.output_tokens}${res.stop_reason === 'max_tokens' ? '  ⚠ TRUNCATED' : ''}`)
  console.log(`--- raw response ---\n${text}`)
  return text
}

// TEST A
await call('TEST A — raw transcript → Haiku (simple instruction)', 'claude-haiku-4-5-20251001', SIMPLE_INSTRUCTION_A, userA, 4000)

// TEST B1 — cloud production (Opus, full transcript, EDL)
const rawB1 = await call('TEST B1 — cloud production (Opus, full transcript, procut-judge prompt)', 'claude-opus-4-8', PROCUT_SYSTEM, userB1, 16000)
const v = validateEdl(rawB1, map)
console.log(`\nvalidateEdl: ok=${v.ok}  word_cuts=${v.edl.word_cuts.length}  pause_cuts=${v.edl.pause_cuts.length}${v.ok ? '' : '  ⚠ REJECTED (unusable/runaway) → nothing staged'}`)
if (v.ok) {
  const refined = refineEdl(v.edl, map)
  const spans: CutSpan[] = refined.edl.word_cuts
    .map((c) => ({ start: map.words[c.from]?.start, end: map.words[c.to]?.end, type: 'failed_retake' as const, source: 'retake_aware_beta' as const, reason: c.reason }))
    .filter((s) => s.start != null && s.end != null) as CutSpan[]
  const transcript = { words: vt.words.map((w, i) => ({ id: `w${i}`, text: w.word, start: w.start, end: w.end })), segments: [] as never[] }
  const ids = spansToWordIds(spans, transcript as never)
  console.log(`refineEdl notes: ${refined.notes.length ? refined.notes.join(' | ') : '(none)'}`)
  console.log(`final cut spans: ${spans.length}  mapped word ids: ${ids.length}`)
  console.log(`cut text preview: ${spans.slice(0, 8).map((s) => `[${vt.words.filter((w) => (w.start + w.end) / 2 >= s.start && (w.start + w.end) / 2 <= s.end).map((w) => w.word).join(' ')}]`).join('  ')}`)
}

// TEST B2 — rules-first (Haiku, filtered) using the EXACT production classifier prompt
const { pickJudge } = await import('../src/main/retakeaware/llm')
void pickJudge // (the exact SYSTEM lives in llm.ts; we call Haiku directly with the same payload)
const rawB2 = await call('TEST B2 — rules-first (Haiku, FILTERED candidates, classifier prompt)', 'claude-haiku-4-5-20251001', CLASSIFIER_SYSTEM, userB2, 4000)
const warns: string[] = []
const parsed = parseLlmDecisions(rawB2, warns)
console.log(`\nparseLlmDecisions: ${parsed ? 'OK' : 'NULL → ALL LLM decisions dropped, rules stand'}  warnings=${JSON.stringify(warns)}`)
if (parsed) {
  console.log(`  retake_group_decisions: ${parsed.retake_group_decisions.length}`)
  console.log(`  filler_decisions: ${parsed.filler_decisions.length}`)
  console.log(`  production_chatter_decisions: ${parsed.production_chatter_decisions?.length ?? 0}  (cut=${(parsed.production_chatter_decisions ?? []).filter((d) => d.decision === 'cut').length})`)
}
console.log(`\n${line()}\nDONE — compare TEST A (broad, full transcript) vs B1 (Opus full/EDL) vs B2 (Haiku filtered).\n${line()}\n`)
