// Offline harness for the Retake-Aware Cut Beta rule engine (pure parts only —
// no providers, no keys, no network). Run: npx tsx scripts/verify-retakeaware.ts
import {
  buildChunks,
  detectFillers,
  findRetakeGroups,
  applyLlmDecisions,
  buildCutSpans,
  spansToWordIds
} from '../src/shared/retakeaware/analyze'
import { parseLlmDecisions } from '../src/main/retakeaware/llm'
import type { VerbatimTranscript, VerbatimWord } from '../src/shared/retakeaware/types'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** words from phrases; `|` = long pause (0.8s) between phrases, words 0.2s apart. */
function vt(phrases: string[]): VerbatimTranscript {
  const words: VerbatimWord[] = []
  let t = 0.5
  for (const phrase of phrases) {
    for (const tok of phrase.split(/\s+/).filter(Boolean)) {
      words.push({ word: tok, start: t, end: t + 0.18, confidence: 0.95 })
      t += 0.2
    }
    t += 0.8 // pause -> chunk boundary
  }
  const raw = words.map((w) => w.word).join(' ')
  return { provider: 'mock', mode: 'verbatim', words, segments: [], utterances: [], raw_text: raw, clean_text: raw }
}

// ---- 1. verbatim/clean separation ----
{
  const x = vt(['uh this is um a test'])
  check('verbatim raw_text keeps disfluencies', /uh .*um/.test(x.raw_text))
}

// ---- review-state: chunks partition ALL words (nothing dropped from the
//      transcript the UI renders from segments) ----
{
  const x = vt(['this product changed my', 'this product changed my skin in seven days', 'and one more clean line here'])
  const chunks = buildChunks(x)
  const covered = new Array(x.words.length).fill(false)
  for (const c of chunks) for (let i = c.wordStart; i <= c.wordEnd; i++) covered[i] = true
  check('every raw word is covered by exactly one chunk (no word hidden)', covered.every(Boolean) && chunks.length > 0, `${covered.filter(Boolean).length}/${x.words.length}`)
  const noGapOverlap = chunks.every((c, i) => i === 0 || c.wordStart === chunks[i - 1].wordEnd + 1)
  check('chunks are contiguous (no overlap/gap)', noGapOverlap)
}

// ---- 2. retake grouping: progressive attempts, keep the most complete ----
{
  const x = vt([
    'this product changed my',
    'this product changed my skin',
    'this product changed my skin in seven days',
    'and something totally unrelated happens here'
  ])
  const chunks = buildChunks(x)
  check('chunking splits on pauses (4 chunks)', chunks.length === 4, `got ${chunks.length}`)
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(chunks, x.words, fillers)
  check('repeated attempts form ONE retake group', groups.length === 1, `got ${groups.length}`)
  const g = groups[0]
  check('group has 3 attempts', g.attempts.length === 3, `got ${g.attempts.length}`)
  const keeper = g.attempts.find((a) => a.attempt_id === g.keep_attempt)!
  check('keeper is the complete take 3', keeper.text.includes('seven days'), keeper.text)
  check('two failed attempts removed', g.remove_attempts.length === 2)

  // ---- 3. whole-attempt spans, never spliced ----
  const spans = buildCutSpans(x, groups, fillers)
  const removed = g.attempts.filter((a) => g.remove_attempts.includes(a.attempt_id))
  const wholeCover = removed.every((a) => spans.some((s) => s.start <= a.start + 0.001 && s.end >= a.end - 0.001))
  check('removed attempts are covered as WHOLE spans', wholeCover)
  const keeperTouched = spans.some((s) => s.start < keeper.end && s.end > keeper.start)
  check('keeper attempt is never touched (no splicing)', !keeperTouched)
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const noOverlap = sorted.every((s, i) => i === 0 || s.start >= sorted[i - 1].end)
  check('no overlapping cut spans', noOverlap)
  check('no micro-cuts', spans.every((s) => s.end - s.start >= 0.12))

  // spans -> review word ids on an app-format transcript
  const appT = {
    segments: [],
    words: x.words.map((w, i) => ({ id: `rw${i}`, text: w.word, start: w.start, end: w.end }))
  }
  const ids = spansToWordIds(spans, appT)
  check('flags cover exactly the failed attempts', ids.length === removed.reduce((n, a) => n + (a.word_end_index - a.word_start_index + 1), 0), `got ${ids.length}`)
}

// ---- 4/5. filler triage: natural kept, ugly removed ----
{
  const x = vt(['honestly this changed everything', 'this is uh um like really good'])
  const fillers = detectFillers(x.words)
  const honestly = fillers.find((f) => f.text.toLowerCase() === 'honestly')
  check('natural "honestly" is KEPT', honestly?.classification === 'keep', honestly?.classification)
  const hes = fillers.find((f) => /uh/.test(f.text.toLowerCase()))
  check('"uh um" cluster is REMOVED', hes?.classification === 'remove' && /um/.test(hes.text), hes?.text)
  const like = fillers.find((f) => f.text.toLowerCase() === 'like')
  check('"like" glued to hesitations is removed', like?.classification === 'remove', like?.classification)
  const spans = buildCutSpans(x, [], fillers)
  const honestlyCut = spans.some((s) => s.start < 0.7 && s.end > 0.5)
  check('no span cuts "honestly"', !honestlyCut)
}

// ---- retake marker phrase ----
{
  const x = vt(['it helped with bloating no wait let me say that again', 'it actually helped my bloating go down'])
  const fillers = detectFillers(x.words)
  const marker = fillers.find((f) => f.classification === 'retake_marker')
  check('spoken retake command detected as retake_marker', !!marker, JSON.stringify(fillers.map((f) => f.text)))
  const { groups } = findRetakeGroups(buildChunks(x), x.words, fillers)
  check('marker links flub to the redo (retake group formed)', groups.length === 1, `got ${groups.length}`)
  if (groups.length === 1) {
    const keeper = groups[0].attempts.find((a) => a.attempt_id === groups[0].keep_attempt)!
    check('keeper is the redo', keeper.text.includes('go down'), keeper.text)
  }
}

// ---- parallel constructions are NOT retakes (real-video false positives) ----
{
  // deliberate list: same frame, substituted tail noun
  const x = vt(['You get the cleansing foam,', 'You get the cleansing oil', 'and you get the mud mask.'])
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(buildChunks(x), x.words, fillers)
  check('parallel list (foam/oil/mask) is NOT a retake group', groups.length === 0, JSON.stringify(groups.map(g => g.attempts.map(a => a.text))))
}
{
  // parallel sentence pair with substituted tails
  const x = vt(["but most importantly it's gonna help strengthen.", "But most importantly it's gonna help restore your skin barrier."])
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(buildChunks(x), x.words, fillers)
  check('substituted-tail sentences are NOT a retake group', groups.length === 0)
}
{
  // AssemblyAI-style broken-off attempt (trailing em dash) IS a retake
  const x = vt(["So if you've been wanting to try this, I'll leave the link to this bundle—", "so if you've been wanting to try this, I'll leave the link to this exact bundle somewhere down here."])
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(buildChunks(x), x.words, fillers)
  check('dash-abandoned attempt IS grouped with its redo', groups.length === 1, `got ${groups.length}`)
  if (groups.length === 1) {
    const keeper = groups[0].attempts.find((a) => a.attempt_id === groups[0].keep_attempt)!
    check('redo is kept, flub removed whole', keeper.text.includes('somewhere down here'), keeper.text)
  }
}

// ---- 8. invalid LLM output falls back to rules ----
{
  const warnings: string[] = []
  check('garbage LLM reply -> null (rules stand)', parseLlmDecisions('sorry, here is my analysis…', warnings) === null)
  const x = vt(['this product changed my', 'this product changed my skin in seven days'])
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(buildChunks(x), x.words, fillers)
  const before = groups[0].keep_attempt
  applyLlmDecisions(
    groups,
    fillers,
    { retake_group_decisions: [{ retake_group_id: 'group_001', keep_attempt: 'take_99', remove_attempts: [], reason: 'x' }], filler_decisions: [{ filler_id: 'nope', decision: 'remove', reason: 'x' }] },
    warnings
  )
  check('impossible attempt id ignored', groups[0].keep_attempt === before)
  check('unknown filler id ignored + warned', warnings.length >= 2, `${warnings.length} warnings`)
  // a VALID decision is applied
  applyLlmDecisions(
    groups,
    fillers,
    { retake_group_decisions: [{ retake_group_id: groups[0].retake_group_id, keep_attempt: 'take_1', remove_attempts: ['take_2'], reason: 'reviewer override' }], filler_decisions: [] },
    warnings
  )
  check('valid LLM override applied', groups[0].keep_attempt === 'take_1')
}

// ---- no repetitions / no fillers -> clean empty result ----
{
  const x = vt(['a perfectly clean single sentence with no problems at all'])
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(buildChunks(x), x.words, fillers)
  const spans = buildCutSpans(x, groups, fillers)
  check('clean speech -> zero groups, zero spans', groups.length === 0 && spans.length === 0)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall retake-aware checks green')
process.exit(failures ? 1 : 0)
