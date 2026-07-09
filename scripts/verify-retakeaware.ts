// Offline harness for the Retake-Aware Cut Beta rule engine (pure parts only —
// no providers, no keys, no network). Run: npx tsx scripts/verify-retakeaware.ts
import {
  buildChunks,
  detectFillers,
  findRetakeGroups,
  extendProgressiveRetakes,
  detectFalseStarts,
  detectSelfCorrections,
  detectRepeatedSetups,
  detectOrphanConnectors,
  isNumberedProgressionPair,
  applyLlmDecisions,
  buildCutSpans,
  spansToWordIds,
} from '../src/shared/retakeaware/analyze'
import { parseLlmDecisions } from '../src/main/retakeaware/llm'
import { detectBetaSilencesHybrid, RETAKE_BETA_SILENCE_PRESETS, DEFAULT_RETAKE_BETA_SILENCE_SETTINGS, type RetakeBetaSilenceSettings } from '../src/shared/retakeaware/silence'
import { computeKeepRanges } from '../src/shared/edit'
import type { VerbatimTranscript, VerbatimWord, CutSpan } from '../src/shared/retakeaware/types'
import type { Project, SilenceRegion } from '../src/shared/types'

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
  // parallel sentence pair with substituted tails: at most a PROVISIONAL group
  // (LLM-gated) — rules alone must never cut it.
  const x = vt(["but most importantly it's gonna help strengthen.", "But most importantly it's gonna help restore your skin barrier."])
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(buildChunks(x), x.words, fillers)
  const confirmed = groups.filter((g) => !g.provisional)
  check('substituted-tail sentences are never a CONFIRMED retake group', confirmed.length === 0, JSON.stringify(groups.map((g) => g.candidate_type)))
  check('…and rules alone cut nothing for them', buildCutSpans(x, groups, fillers).length === 0)
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

// ---- F1. abandoned false start: cut only the dashed tail, keep the hook ----
{
  const x = vt(["Okay ladies, if you are a baddie on a budget, I'm gonna need—", 'then this is for you because this stuff is great'])
  const chunks = buildChunks(x)
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(chunks, x.words, fillers)
  const fs = detectFalseStarts(chunks, x.words, groups)
  check('F1: false start detected', fs.length === 1, JSON.stringify(fs))
  if (fs.length === 1) {
    check('F1: cuts ONLY "I\'m gonna need—"', /gonna need/.test(fs[0].text) && !/baddie|budget/.test(fs[0].text), fs[0].text)
    const spans = buildCutSpans(x, groups, fillers, fs, [])
    const hookMid = (x.words[2].start + x.words[2].end) / 2 // "if" of the hook
    check('F1: hook words untouched', !spans.some((s) => hookMid >= s.start && hookMid <= s.end))
    const contMid = (x.words[14].start + x.words[14].end) / 2 // "this" of the continuation
    check('F1: continuation untouched', !spans.some((s) => contMid >= s.start && contMid <= s.end))
  }
}

// ---- F2. same sentence, final word swapped (scent -> perfume) ----
{
  const x = vt(["I'm trying to get my girl this scent.", "I'm trying to get my girl this perfume."])
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(buildChunks(x), x.words, fillers)
  check('F2: prefix-swap retake grouped', groups.length === 1 && !groups[0].provisional, JSON.stringify(groups.map((g) => g.candidate_type)))
  if (groups.length === 1) {
    const keeper = groups[0].attempts.find((a) => a.attempt_id === groups[0].keep_attempt)!
    check('F2: keeps the LATER "perfume" version', /perfume/.test(keeper.text), keeper.text)
    const spans = buildCutSpans(x, groups, fillers)
    const first = groups[0].attempts[0]
    check('F2: earlier version removed whole', spans.some((s) => s.start <= first.start + 0.01 && s.end >= first.end - 0.01))
  }
}

// ---- F3. in-chunk self-correction ("…if you got— or …") ----
{
  const x = vt(['Like, do not be surprised if you got— or do not be surprised if your mans wants to live in your neck after this'])
  const chunks = buildChunks(x)
  const sc = detectSelfCorrections(chunks, x.words)
  check('F3: self-correction detected', sc.length === 1, JSON.stringify(sc))
  if (sc.length === 1) {
    check('F3: cut covers "if you got— or"', /you got— or$/.test(sc[0].text), sc[0].text)
    const spans = buildCutSpans(x, [], [], [], sc)
    const idx = (t: string): number => x.words.findIndex((w) => w.word === t)
    const mansMid = (x.words[idx('mans')].start + x.words[idx('mans')].end) / 2
    check('F3: the redo ("your mans wants…") untouched', !spans.some((s) => mansMid >= s.start && mansMid <= s.end))
    // the SECOND "do not be surprised" (the redo's opening) must stay
    const secondDo = x.words.map((w, i) => ({ w, i })).filter((e) => e.w.word === 'do')[1]
    const secondDoMid = (secondDo.w.start + secondDo.w.end) / 2
    check('F3: re-said opening stays', !spans.some((s) => secondDoMid >= s.start && secondDoMid <= s.end))
  }
}

// ---- F4. progressive incomplete attempt with dash (lowered threshold) ----
{
  const x = vt(['But I wish I grabbed 2 because I had to wait a freaking—', 'I wish I grabbed 2 because I literally had to wait 2 weeks to order this one.'])
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(buildChunks(x), x.words, fillers)
  check('F4: dash-abandoned low-sim retake grouped', groups.length === 1 && !groups[0].provisional, JSON.stringify(groups.map((g) => `${g.candidate_type}/${g.provisional}`)))
  if (groups.length === 1) {
    const keeper = groups[0].attempts.find((a) => a.attempt_id === groups[0].keep_attempt)!
    check('F4: complete second attempt kept', /2 weeks/.test(keeper.text), keeper.text)
  }
}

// ---- tail_fragment_continuation_veto / cross_chunk_completion_veto (pore-set video, 2026-07-08) ----
{
  // chunk 2 hits CHUNK_MAX_WORDS mid-sentence (no terminal punct) and its
  // grammatical completion ("clear out those pores.") must NEVER be compared
  // against an earlier, textually-similar SHORT sentence as an independent
  // retake attempt.
  const longNoPunct = Array.from({ length: 26 }, (_, i) => `filler${i}`).join(' ') + ' which is only a 5-step routine to help'
  const x = vt(['5-step routine to help clear out those pores.', longNoPunct, 'clear out those pores.'])
  const { groups, rejections } = findRetakeGroups(buildChunks(x), x.words, detectFillers(x.words))
  check('tail-fragment continuation forms NO retake group', groups.length === 0, JSON.stringify(groups.map((g) => g.attempts.map((a) => a.text))))
  check('veto reason names cross_chunk_completion_veto', rejections.some((r) => r.candidate_type === 'tail_fragment_continuation_veto' && /cross_chunk_completion_veto/.test(r.rejection_reason)), JSON.stringify(rejections))
}

// ---- numbered_progression_veto / parallel_countdown_list_veto (mouthwash video, 2026-07-08) ----
{
  const x = vt(["you're not just gonna get one, you're not just gonna get two, you're not just gonna get three,", "you're not just gonna get four,", 'but you are gonna get five of these.'])
  const chunks = buildChunks(x)
  check('countdown list is a numbered-progression pair', isNumberedProgressionPair(chunks[0].norm, chunks[1].norm))
  const { groups, rejections } = findRetakeGroups(chunks, x.words, detectFillers(x.words))
  check('countdown list forms NO retake group', groups.length === 0, JSON.stringify(groups.map((g) => g.attempts.map((a) => a.text))))
  check('veto reason names parallel_countdown_list_veto', rejections.some((r) => r.candidate_type === 'numbered_progression_veto' && /parallel_countdown_list_veto/.test(r.rejection_reason)))
  const spans = buildCutSpans(x, groups, detectFillers(x.words))
  check('"four" is never cut', spans.length === 0)
}
{
  // a genuinely doubled number ("one, one") is NOT a progression — stays out
  // of scope for this veto (would need other signals to judge; the veto must
  // not blanket-protect every number-adjacent pair).
  const x = vt(['give me item one,', 'give me item one,'])
  const chunks = buildChunks(x)
  check('identical repeated number is NOT a progression pair', !isNumberedProgressionPair(chunks[0].norm, chunks[1].norm))
}

// ---- repeated_setup_retake_detector + orphan_connector_before_restart_detector (study-guide video, 2026-07-08) ----
{
  const x = vt([
    'And I came across this study guide, and ever since then, every week at church, I came across',
    'study guide.',
    "And ever since then, every week at church when there's a different story being told, I can actually relate to it."
  ])
  const chunks = buildChunks(x)
  const rs = detectRepeatedSetups(chunks, x.words)
  check('repeated setup detected', rs.length === 1, JSON.stringify(rs.map((r) => r.text)))
  if (rs.length === 1) {
    check('cut covers the abandoned restart through the leftover fragment', /^and ever since then.*came across study guide\.$/i.test(rs[0].text), rs[0].text)
    const spans = buildCutSpans(x, [], detectFillers(x.words), [], [], rs, [])
    const idx = x.words.findIndex((w) => w.word === 'guide,')
    const mid = (x.words[idx].start + x.words[idx].end) / 2
    check('the FIRST "study guide," (real content) stays', !spans.some((s) => mid >= s.start && mid <= s.end))
    const redoIdx = x.words.findIndex((w) => w.word === "there's")
    const redoMid = (x.words[redoIdx].start + x.words[redoIdx].end) / 2
    check('the redo sentence is untouched', !spans.some((s) => redoMid >= s.start && redoMid <= s.end))
  }
}
{
  const x = vt(['most Christians feel the same way.', 'And', "But now there's truly a better way to connect to our faith."])
  const chunks = buildChunks(x)
  const oc = detectOrphanConnectors(chunks, x.words)
  check('orphan connector "And" detected', oc.length === 1 && oc[0].text === 'And', JSON.stringify(oc.map((o) => o.text)))
}
{
  // negative: a REAL one-word sentence/interjection that ISN'T followed by a
  // different connective must stay untouched.
  const x = vt(['Okay.', 'Great, let us continue with the demo now.'])
  const chunks = buildChunks(x)
  const oc = detectOrphanConnectors(chunks, x.words)
  check('non-connective single-word chunk is not flagged', oc.length === 0, JSON.stringify(oc.map((o) => o.text)))
}

// ---- large progressive retake spanning MULTIPLE chunks (calmeter video, 2026-07-08) ----
{
  // A restarted PARAGRAPH re-chunks differently than the original (the retry
  // has an extra stutter-split not present in the first attempt) — this is
  // exactly what breaks naive single-chunk-pair matching and requires the
  // forward-extension pass.
  const x = vt([
    'Everybody who is not at their dream body thinks, okay, I work out a little, I eat somewhat healthy,',
    'but I cheat, you know, I cheat a little bit.',
    'I eat some ice cream, maybe some pizza.',
    'Everybody who is not at their dream body thinks, okay, I work out a little bit,',
    'I eat somewhat healthy,',
    'but I like to cheat.',
    'I like to have pizza, I like to have ice cream, but that is not that bad.'
  ])
  const chunks = buildChunks(x)
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(chunks, x.words, fillers)
  extendProgressiveRetakes(chunks, groups, x.words, fillers)
  const confirmed = groups.filter((g) => !g.provisional && !g.llm_rejected)
  check('progressive multi-chunk retake forms ONE group', confirmed.length === 1, JSON.stringify(confirmed.map((g) => g.attempts.length)))
  if (confirmed.length === 1) {
    const g = confirmed[0]
    check('group is EXTENDED past its anchor chunk', g.extended === true)
    const keeper = g.attempts.find((a) => a.attempt_id === g.keep_attempt)!
    check('keeper covers the WHOLE second attempt (not just its opening chunk)', /that is not that bad/.test(keeper.text), keeper.text)
    const loser = g.attempts.find((a) => a.attempt_id !== g.keep_attempt)!
    check('removed attempt covers the WHOLE first attempt (not just its opening chunk)', /maybe some pizza/.test(loser.text), loser.text)
    const spans = buildCutSpans(x, groups, fillers)
    const keeperMid = (keeper.start + keeper.end) / 2
    check('keeper is never touched by the removal span', !spans.some((s) => keeperMid >= s.start && keeperMid <= s.end))
  }
}

// ---- micro pronoun / connector stutter (global, cross-chunk-boundary) ----
{
  // "I," ends one chunk, "I eat..." starts the next — the stutter seam lands
  // exactly on the pause used to split chunks, so this must NOT be bounded to
  // a single chunk (that was the original bug).
  const x = vt(['I work out a little bit, I,', 'I eat somewhat healthy, but I like to cheat.'])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  check('cross-chunk pronoun stutter "I," caught', sc.some((s) => s.kind === 'stutter_restart' && s.text === 'I,'), JSON.stringify(sc.map((s) => s.text)))
}
{
  // "Because," / "because" — a repeated CONNECTIVE, not a content word.
  const x = vt(['Because, because I thought I was eating fifteen hundred calories a day.'])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  check('repeated connector "Because," caught', sc.some((s) => s.kind === 'stutter_restart' && /Because,/.test(s.text)), JSON.stringify(sc.map((s) => s.text)))
}
{
  // content-word single repeats stay (regression: unchanged from before).
  const x = vt(["I've never, never gotten one from this before."])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  check('content-word "never, never" still untouched', sc.length === 0, JSON.stringify(sc.map((s) => s.text)))
}
{
  // NEGATIVE: two independent complete sentences sharing a word at the seam
  // ("...literally it. It is that easy.") must NOT be treated as a stutter —
  // the first occurrence ends a finished sentence, not an abandoned one.
  const x = vt(['That is literally it.', 'It is that easy.'])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  check('sentence-boundary "it. It" is NOT a stutter', sc.length === 0, JSON.stringify(sc.map((s) => s.text)))
}

// ---- in-chunk patterns from the scalp-brush video (2026-07-08) ----
{
  // leading dashed orphan at chunk start
  const x = vt(['your— be very careful using this scalp brush because it works'])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  check('leading orphan "your—" cut', sc.length === 1 && sc[0].text === 'your—', JSON.stringify(sc.map((s) => s.text)))
}
{
  // corrected word breaks exact repeat ("30" -> "36")
  const x = vt(['And these 30— and these 36 bristles massage it straight in.'])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  check('numeric correction "And these 30—" cut', sc.length === 1 && /30—$/.test(sc[0].text) && !/36/.test(sc[0].text), JSON.stringify(sc.map((s) => s.text)))
}
{
  // redo inserts a lead-in token ("it's")
  const x = vt(["Starting to get— it's starting to get popular on TikTok, so they've been selling out."])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  check('inserted-lead-in "Starting to get—" cut', sc.length === 1 && /get—$/.test(sc[0].text) && !/it's/.test(sc[0].text), JSON.stringify(sc.map((s) => s.text)))
}
{
  // immediate stutter restart WITHOUT dash
  const x = vt(["It's got PDRN, it's got PDRN and plant-derived exosomes that absorb in."])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  check('adjacent repeat "It\'s got PDRN," cut once', sc.length === 1 && /PDRN,?$/.test(sc[0].text), JSON.stringify(sc.map((s) => s.text)))
}
{
  // single-word emphasis is NOT a stutter
  const x = vt(["I've never, never gotten one from this one."])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  check('"never, never" emphasis untouched', sc.length === 0, JSON.stringify(sc.map((s) => s.text)))
}

// ---- micro cutoff fragments + partial-word restarts (enzymes video) ----
{
  // two stacked cutoffs in one chunk: 'and it—' then 'and they help break—'
  const x = vt(['So your body produces its own digestive enzymes and it— and they help break— and they help break down the food that you eat.'])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  const texts = sc.map((s) => s.text)
  check('micro cutoff "and it—" caught', sc.some((s) => s.kind === 'micro_cutoff_fragment' && /and it—/.test(s.text)), JSON.stringify(texts))
  check('second cutoff "and they help break—" caught', sc.some((s) => /and they help break—/.test(s.text)), JSON.stringify(texts))
  const spans = buildCutSpans(x, [], [], [], sc)
  const idx = x.words.findIndex((w) => w.word === 'down')
  const downMid = (x.words[idx].start + x.words[idx].end) / 2
  check('keeper "break down the food…" untouched', !spans.some((s) => downMid >= s.start && downMid <= s.end))
}
{
  // partial-word restart: 'pre- Pre and probiotics' -> cut only 'pre-'
  const x = vt(["There's not only enzymes in here but pre- Pre and probiotics."])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  const pw = sc.find((s) => s.kind === 'partial_word_restart')
  check('partial-word "pre-" caught', !!pw && pw.text === 'pre-', JSON.stringify(sc.map((s) => `${s.kind}:${s.text}`)))
  const spans = buildCutSpans(x, [], [], [], sc)
  const preFull = x.words.findIndex((w) => w.word === 'Pre')
  const preMid = (x.words[preFull].start + x.words[preFull].end) / 2
  check('keeper "Pre and probiotics" untouched', !spans.some((s) => preMid >= s.start && preMid <= s.end))
  const butIdx = x.words.findIndex((w) => w.word === 'but')
  const butMid = (x.words[butIdx].start + x.words[butIdx].end) / 2
  check('"but" not swept into the partial-word cut', !spans.some((s) => butMid >= s.start && butMid <= s.end))
}
{
  // do NOT blindly cut every hyphen/dash: a dashed word whose stem is NOT the
  // next word's prefix and has no same-connective restart stays.
  const x = vt(['I love this big-ass burrito and it fills me up completely every time.'])
  const sc = detectSelfCorrections(buildChunks(x), x.words)
  check('hyphenated compound "big-ass" is not a cutoff', sc.length === 0, JSON.stringify(sc.map((s) => s.text)))
}

// ---- D. ambiguous pairs become PROVISIONAL (LLM-gated), never rule-cut ----
{
  const x = vt(['It just smells so clean, so rich, fresh.', 'It just smells so freaking good and fresh.'])
  const fillers = detectFillers(x.words)
  const { groups } = findRetakeGroups(buildChunks(x), x.words, fillers)
  check('ambiguous mid-sim pair becomes provisional group', groups.length === 1 && groups[0].provisional === true, JSON.stringify(groups))
  const spans = buildCutSpans(x, groups, fillers)
  check('provisional group produces NO cuts without LLM', spans.length === 0)
  // LLM veto path
  const warnings: string[] = []
  applyLlmDecisions(groups, fillers, { retake_group_decisions: [{ retake_group_id: groups[0].retake_group_id, keep_attempt: '', remove_attempts: [], reason: 'deliberate emphasis', not_a_retake: true }], filler_decisions: [] }, warnings)
  check('LLM can veto (not_a_retake)', groups[0].llm_rejected === true)
  // LLM affirm path on a fresh copy
  const { groups: g2 } = findRetakeGroups(buildChunks(x), x.words, fillers)
  applyLlmDecisions(g2, fillers, { retake_group_decisions: [{ retake_group_id: g2[0].retake_group_id, keep_attempt: 'take_2', remove_attempts: ['take_1'], reason: 'retry', not_a_retake: false }], filler_decisions: [] }, warnings)
  const spans2 = buildCutSpans(x, g2, fillers)
  check('LLM affirmation makes the provisional group cut', spans2.length === 1 && g2[0].provisional === undefined)
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

// ---- Retake β HYBRID silence + settings + ripple/anti-sliver ----
const S = (p?: Partial<RetakeBetaSilenceSettings>): RetakeBetaSilenceSettings => ({ ...DEFAULT_RETAKE_BETA_SILENCE_SETTINGS, ...p })
function scene(before: string, gap: number, after: string): { words: VerbatimWord[]; prevEnd: number; nextStart: number } {
  const words: VerbatimWord[] = []
  let t = 0.5
  for (const tok of before.split(/\s+/).filter(Boolean)) { words.push({ word: tok, start: t, end: t + 0.2 }); t += 0.26 }
  const prevEnd = words[words.length - 1].end
  t = prevEnd + gap
  const nextStart = t
  for (const tok of after.split(/\s+/).filter(Boolean)) { words.push({ word: tok, start: t, end: t + 0.2 }); t += 0.26 }
  return { words, prevEnd, nextStart }
}
// Build a project with word cuts (deleted) + silence regions and return keeps.
function keepsFor(words: VerbatimWord[], silences: SilenceRegion[], deletedIdx: Set<number> = new Set()): { start: number; end: number }[] {
  const dur = words[words.length - 1].end + 0.5
  const project = {
    version: 1, name: 't', media: { path: 'x', duration: dur } as any,
    transcript: { words: words.map((w, i) => ({ id: `w${i}`, text: w.word, start: w.start, end: w.end, deleted: deletedIdx.has(i) })), segments: [] },
    silences, tracks: [], playhead: 0, pxPerSec: 80, magnet: false, trackHeight: 90,
    baseSplits: [], manualCuts: [], keepOverrides: [], silencePadding: 0.08, showThumbnails: true, texts: [], aspectW: 0, aspectH: 0
  } as unknown as Project
  return computeKeepRanges(project, null)
}
const BEF = 'this is a perfectly normal clean sentence'
const AFT = 'results were great here today now'

// 1. Silence removal does NOT leave the removed interval as a clip.
{
  const sc = scene(BEF, 2.0, AFT)
  const { regions } = detectBetaSilencesHybrid(sc.words, [], [], S())
  const keeps = keepsFor(sc.words, regions)
  const r = regions[0]
  const leftAsClip = keeps.some((k) => k.start >= r.start - 0.02 && k.end <= r.end + 0.02)
  check('silence: removed interval is NOT left as a clip', !!r && !leftAsClip && keeps.length === 2, `keeps=${keeps.length}`)
}
// 2. Silence removal ripple-closes the gap (kept words on both sides survive, gap gone).
{
  const sc = scene(BEF, 2.0, AFT)
  const { regions } = detectBetaSilencesHybrid(sc.words, [], [], S())
  const keeps = keepsFor(sc.words, regions)
  const inKeep = (a: number, b: number) => keeps.some((k) => k.start <= a + 1e-6 && k.end >= b - 1e-6)
  check('silence: ripple-closes — words before & after both kept, silence gone', inKeep(sc.prevEnd - 0.1, sc.prevEnd) && inKeep(sc.nextStart, sc.nextStart + 0.1) && keeps.reduce((n, k) => n + (k.end - k.start), 0) < sc.words[sc.words.length - 1].end)
}
// 3 & 4. Silence cut adjacent to a WORD cut does not create a <0.5s sliver clip
//        (anti-sliver merges the air; no micro-clip; word not eaten).
{
  const words: VerbatimWord[] = []
  let t = 0.5
  for (const w of 'keep this take'.split(' ')) { words.push({ word: w, start: t, end: t + 0.2 }); t += 0.26 }
  const rs = t; for (const w of 'take again'.split(' ')) { words.push({ word: w, start: t, end: t + 0.2 }); t += 0.26 }
  const prevEnd = words[words.length - 1].end
  t = prevEnd + 1.8; for (const w of 'next sentence here now today'.split(' ')) { words.push({ word: w, start: t, end: t + 0.2 }); t += 0.26 }
  const deleted = new Set<number>(); words.forEach((w, i) => { if (w.start >= rs - 0.01 && w.end <= prevEnd + 0.01) deleted.add(i) })
  const wordCut: CutSpan = { start: rs - 0.02, end: prevEnd + 0.02, type: 'failed_retake', source: 'retake_aware_beta', reason: 'x' }
  const { regions } = detectBetaSilencesHybrid(words, [wordCut], [], S())
  const keeps = keepsFor(words, regions, deleted)
  const slivers = keeps.filter((k) => k.end - k.start < 0.5)
  check('silence: no timeline clip under 0.5s next to a word cut (anti-sliver)', slivers.length === 0, `slivers=${slivers.map((k) => `[${k.start.toFixed(2)},${k.end.toFixed(2)}]`).join(' ')}`)
  check('silence: kept "next sentence" survives (no speech eaten)', keeps.some((k) => k.start <= prevEnd + 1.8 && k.end >= prevEnd + 2.0))
}
// 4b. Dead air BETWEEN two removed retakes (or cut+silence) leaves NO residue
//     clip, regardless of size (the ~00:30 residue-clip bug).
{
  const words: VerbatimWord[] = []
  let t = 0.5
  const push = (w: string) => { words.push({ word: w, start: t, end: t + 0.2 }); t += 0.26 }
  ;['keep', 'this', 'part'].forEach(push)
  const a1s = t; ['bad', 'take', 'one'].forEach(push); const a1e = words[words.length - 1].end
  t += 1.2 // 1.2s of dead air between the two removed attempts (> BRIDGE_GAP)
  const a2s = t; ['bad', 'take', 'two'].forEach(push); const a2e = words[words.length - 1].end
  t += 0.5; ['then', 'more', 'content', 'here'].forEach(push)
  const deleted = new Set<number>()
  words.forEach((w, i) => { if ((w.start >= a1s - 0.01 && w.end <= a1e + 0.01) || (w.start >= a2s - 0.01 && w.end <= a2e + 0.01)) deleted.add(i) })
  const sil: SilenceRegion[] = [{ id: 's', start: a2e + 0.6, end: a2e + 0.9, action: 'remove', protect: true }] // any protected silence triggers the pass
  const keeps = keepsFor(words, sil, deleted)
  const airInGap = keeps.some((k) => k.start >= a1e - 0.15 && k.end <= a2s + 0.15 && k.end - k.start > 0.1)
  check('silence: dead air between two removed retakes leaves NO residue clip', !airInGap, `keeps=${keeps.map((k) => `[${k.start.toFixed(1)},${k.end.toFixed(1)}]`).join(' ')}`)
}
// 5. Settings change min pause + target remaining pause.
{
  const sc = scene(BEF, 1.0, AFT) // 1.0s gap
  const balanced = detectBetaSilencesHybrid(sc.words, [], [], S({ minPauseS: 1.2 })) // 1.0 < 1.2 -> dropped
  const loose = detectBetaSilencesHybrid(sc.words, [], [], S({ minPauseS: 0.85, targetRemainingS: 0.4, paddingBeforeS: 0.2, paddingAfterS: 0.25, minRemovedS: 0.45 }))
  check('silence: settings min pause gates candidates', balanced.regions.length === 0 && loose.regions.length === 1)
  const sc2 = scene(BEF, 2.0, AFT)
  const tight = detectBetaSilencesHybrid(sc2.words, [], [], S({ targetRemainingS: 0.4, paddingBeforeS: 0.2, paddingAfterS: 0.2 }))
  const roomy = detectBetaSilencesHybrid(sc2.words, [], [], S({ targetRemainingS: 0.9 }))
  const remT = 2.0 - (tight.regions[0].end - tight.regions[0].start)
  const remR = 2.0 - (roomy.regions[0].end - roomy.regions[0].start)
  check('silence: target remaining pause changes residual', remT < remR - 0.2, `tight=${remT.toFixed(2)} roomy=${remR.toFixed(2)}`)
}
// 6. Conservative preset creates FEWER cuts than Balanced (on the same gaps).
// 7. Aggressive creates MORE than Balanced, and never removes breaths by default.
{
  // gaps: 0.9, 1.3, 1.7 (varied) — plus tiny breaths
  const words: VerbatimWord[] = []
  let t = 0.5
  const push = (n: number, gapAfter: number) => { for (let k = 0; k < n; k++) { words.push({ word: 'w', start: t, end: t + 0.2 }); t += 0.26 } ; t += gapAfter }
  push(3, 0.9); push(3, 1.3); push(3, 1.7); push(3, 2.4); push(3, 0.4); push(3, 0)
  const dur = words[words.length - 1].end
  const cons = detectBetaSilencesHybrid(words, [], [], S({ preset: 'conservative', ...RETAKE_BETA_SILENCE_PRESETS.conservative }), dur)
  const bal = detectBetaSilencesHybrid(words, [], [], S({ preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced }), dur)
  const agg = detectBetaSilencesHybrid(words, [], [], S({ preset: 'aggressive', ...RETAKE_BETA_SILENCE_PRESETS.aggressive }), dur)
  check('silence: Conservative preset cuts <= Balanced', cons.regions.length <= bal.regions.length, `cons=${cons.regions.length} bal=${bal.regions.length}`)
  check('silence: Aggressive preset cuts >= Balanced', agg.regions.length >= bal.regions.length, `agg=${agg.regions.length} bal=${bal.regions.length}`)
  check('silence: no preset removes breaths by default (0.4s gap never cut)', [cons, bal, agg].every((r) => !r.debug.per_region.some((p) => p.kept && p.transcript_gap_duration < 0.7)))
}
// 8. Debug JSON includes the settings used.
{
  const sc = scene(BEF, 2.0, AFT)
  const res = detectBetaSilencesHybrid(sc.words, [], [], S({ preset: 'aggressive', ...RETAKE_BETA_SILENCE_PRESETS.aggressive }))
  const u = res.debug.retake_beta_silence_settings_used
  check('silence: debug records settings used', u.preset === 'aggressive' && u.min_pause_s === 0.85 && u.target_remaining_pause_s === 0.4 && u.anti_sliver_protection === true && u.remove_breaths === false)
}
// (9. FastCut/ProCut unchanged — asserted by the fast-cut/retake-cuts/repeats/cutcutpro
//     harnesses + the fact edit.ts protected-silence code only runs when protect:true.)
// 10. VAD refinement: silence AssemblyAI hid INSIDE an over-long word (its end
//     padded through the pause) is exposed by VAD and cut — the "noise seen as
//     voice" bug. Transcript-only misses it; hybrid+VAD catches it.
{
  const words: VerbatimWord[] = [
    { word: 'hello', start: 0.5, end: 0.7 },
    { word: "it's", start: 1.0, end: 4.5 }, // spoken ~1.0–1.25, then 3.25s of silence absorbed into the word
    { word: 'world', start: 4.6, end: 4.8 }
  ]
  const opt = S({ minPauseS: 1.0, minRemovedS: 0.4, paddingBeforeS: 0.2, paddingAfterS: 0.2 })
  const noVad = detectBetaSilencesHybrid(words, [], [], opt)
  const vad = [{ start: 1.25, end: 4.55 }] // VAD: real speech ends at 1.25, silence to 4.55
  const withVad = detectBetaSilencesHybrid(words, [], vad, opt)
  check('silence: VAD exposes silence hidden inside an over-long word (noise-as-voice fix)',
    noVad.regions.length === 0 && withVad.regions.length === 1 && withVad.regions[0].end - withVad.regions[0].start > 2.0,
    `noVad=${noVad.regions.length} withVad=${withVad.regions.length}`)
}
// 10b. Asymmetric residual: with VAD onset, the lead-in BEFORE the next word is
//      tight (~100ms); the trailing air AFTER the previous word keeps the rest.
{
  const sc = scene(BEF, 2.0, AFT)
  const vad = [{ start: sc.prevEnd, end: sc.nextStart }] // gap is real silence
  const { regions } = detectBetaSilencesHybrid(sc.words, [], vad, S({ preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced }))
  const r = regions[0]
  const leadIn = r ? sc.nextStart - r.end : 9
  const trailing = r ? r.start - sc.prevEnd : 0
  check('silence: lead-in before next word is tight (~100ms), trailing keeps the rest',
    !!r && leadIn <= 0.12 + 1e-6 && trailing > leadIn + 0.1, `leadIn=${leadIn.toFixed(3)} trailing=${trailing.toFixed(3)}`)
}
// 10c. VAD interior speech island → CARVE, not drop. A long pause with a VAD
//      "speech" blob in the middle that has NO transcript word (a breath/noise, or
//      a mumble AssemblyAI dropped) used to be REJECTED whole, leaving the ENTIRE
//      gap as dead air ("0:13–0:17 just silence, not cut"). Now the silence is
//      carved AROUND the island; computeKeepRanges' wordless-residue drop clears it.
{
  const words: VerbatimWord[] = [
    { word: 'one', start: 10.0, end: 10.2 },
    { word: 'but', start: 15.0, end: 15.2 },
    { word: 'this', start: 15.3, end: 15.5 }
  ]
  const vad = [{ start: 10.2, end: 12.0 }, { start: 13.1, end: 15.0 }] // 1.1s speech island at [12.0,13.1]
  const opt = S({ preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced, maxCutsPerMinute: 60 })
  const res = detectBetaSilencesHybrid(words, [], vad, opt, 16.0)
  const reg = res.regions
  const clipsIsland = reg.some((r) => r.start < 13.1 - 0.05 && r.end > 12.0 + 0.05) // any region overlapping the island's core
  const gapRec = res.debug.per_region.find((r) => r.previous_word === 'one' && r.next_word === 'but')
  check('silence: interior speech island is CARVED around, not dropped whole',
    reg.length >= 2 && !clipsIsland && !!gapRec?.kept && (gapRec?.carved_around_speech_islands?.length ?? 0) === 1 && !gapRec?.rejected_due_to_vad_speech_inside_center,
    `regions=${reg.length} kept=${gapRec?.kept} islands=${gapRec?.carved_around_speech_islands?.length} rejGap=${gapRec?.rejected_due_to_vad_speech_inside_center} clips=${clipsIsland}`)
  const removed = reg.reduce((n, r) => n + (r.end - r.start), 0)
  check('silence: carve removes dead air on BOTH sides of the island', removed > 2.0, `removed=${removed.toFixed(2)}`)
  const keeps = keepsFor(words, reg)
  const worstDead = keeps.filter((k) => k.start >= 10.3 && k.end <= 14.95 && !words.some((w) => (w.start + w.end) / 2 > k.start && (w.start + w.end) / 2 < k.end))
    .reduce((m, k) => Math.max(m, k.end - k.start), 0)
  check('silence: carved gap leaves no long dead-air clip on the timeline (residue-dropped)', worstDead < 0.6, `worstDead=${worstDead.toFixed(2)}`)
}
// 10d. Island so large neither side has minRemovedS of silence left → full reject
//      (never carve a not-worth-it sliver; preserve the old safety in that corner).
{
  const words: VerbatimWord[] = [
    { word: 'alpha', start: 5.0, end: 5.3 },
    { word: 'beta', start: 9.0, end: 9.3 }
  ]
  const vad = [{ start: 5.3, end: 6.0 }, { start: 8.3, end: 9.0 }] // 2.3s island [6.0,8.3], only ~0.3s silence each side after guards
  const opt = S({ preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced })
  const res = detectBetaSilencesHybrid(words, [], vad, opt, 10.0)
  const gapRec = res.debug.per_region.find((r) => r.previous_word === 'alpha' && r.next_word === 'beta')
  check('silence: oversized interior island with no worthwhile side-silence is rejected (no sliver carve)',
    res.regions.length === 0 && !!gapRec?.rejected_due_to_vad_speech_inside_center && !gapRec?.kept && res.debug.carved_around_speech_islands === 0,
    `regions=${res.regions.length} rejGap=${gapRec?.rejected_due_to_vad_speech_inside_center} kept=${gapRec?.kept} carved=${res.debug.carved_around_speech_islands}`)
}
// 11. Leading/trailing dead air is trimmed (edges have no bounding word).
{
  const words: VerbatimWord[] = []
  let t = 2.0 // 2s leading silence
  for (const w of 'this is the content here'.split(' ')) { words.push({ word: w, start: t, end: t + 0.2 }); t += 0.26 }
  const lastEnd = words[words.length - 1].end
  const mediaEnd = lastEnd + 3.0 // 3s trailing silence
  const opt = S({ preset: 'aggressive', ...RETAKE_BETA_SILENCE_PRESETS.aggressive, maxCutsPerMinute: 30 })
  const vad = [{ start: 0, end: 2.0 }, { start: lastEnd, end: mediaEnd }]
  const res = detectBetaSilencesHybrid(words, [], vad, opt, mediaEnd)
  const lead = res.debug.per_region.find((r) => r.previous_word === '(video start)')
  const trail = res.debug.per_region.find((r) => r.next_word === '(video end)')
  check('silence: leading dead air is trimmed from the very start', !!lead && lead.kept && lead.final_cut_start === 0)
  check('silence: trailing dead air is trimmed to the media end', !!trail && trail.kept && Math.abs((trail.final_cut_end ?? 0) - mediaEnd) < 0.01)
  // VAD safety: if the "leading" region is NOT actually silent, do not cut it (protects a music/intro).
  const noisy = detectBetaSilencesHybrid(words, [], [{ start: 1.0, end: 1.5 }], opt, mediaEnd)
  check('silence: leading not cut when VAD says it is not silent (protects intro)', !noisy.debug.per_region.some((r) => r.previous_word === '(video start)' && r.kept))
}

// ---- no-transcript noise-island classifier (record-button clicks etc.) ----
// 12 + 15. Record-button click BEFORE the first word is removed; the real first
//          word is NOT clipped (transcript words are the source of truth for speech).
{
  const words: VerbatimWord[] = [
    { word: 'hello', start: 3.0, end: 3.2 }, { word: 'there', start: 3.3, end: 3.5 }, { word: 'friend', start: 3.6, end: 3.9 }
  ]
  const vad = [{ start: 0, end: 2.0 }, { start: 2.3, end: 3.0 }] // a 0.3s click (non-silence) at [2.0,2.3] before speech
  const opt = S({ preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced, maxCutsPerMinute: 60 })
  const res = detectBetaSilencesHybrid(words, [], vad, opt, 4.5)
  const island = res.debug.no_transcript_islands.find((x) => x.where === 'leading_edge')
  check('silence: record-button click before speech is classified noise & removed',
    !!island && island.decision === 'remove' && (island.classification === 'likely_noise_click' || island.classification === 'likely_breath_noise') && res.debug.noise_islands_removed >= 1,
    `island=${JSON.stringify(island)}`)
  const keeps = keepsFor(words, res.regions)
  const clickKept = keeps.some((k) => k.start <= 2.15 && k.end >= 2.15) // the click's midpoint
  const firstWordKept = keeps.some((k) => k.start <= 3.0 + 1e-6 && k.end >= 3.2 - 1e-6)
  check('silence: the click clip is gone from the timeline', !clickKept, `keeps=${keeps.map((k) => `[${k.start.toFixed(2)},${k.end.toFixed(2)}]`).join(' ')}`)
  check('silence: the real first word after the click is NOT clipped', firstWordKept)
}
// 13. Short tap/click INSIDE a transcript gap is removed (cut through, not protected).
{
  const words: VerbatimWord[] = [{ word: 'done', start: 1.0, end: 1.5 }, { word: 'okay', start: 5.0, end: 5.3 }]
  const vad = [{ start: 1.5, end: 3.0 }, { start: 3.5, end: 5.0 }] // 0.5s click island at [3.0,3.5]
  const opt = S({ preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced })
  const res = detectBetaSilencesHybrid(words, [], vad, opt, 6.0)
  const island = res.debug.no_transcript_islands.find((x) => x.where === 'transcript_gap')
  const keeps = keepsFor(words, res.regions)
  const clickKept = keeps.some((k) => k.start <= 3.25 && k.end >= 3.25)
  check('silence: short click inside a transcript gap is classified noise & cut through',
    !!island && island.decision === 'remove' && island.classification === 'likely_noise_click' && !clickKept,
    `island=${JSON.stringify(island)} clickKept=${clickKept}`)
}
// 14. A no-transcript clip in the uncertain band (0.6–0.75s) is removed as a standalone wordless clip.
{
  const words: VerbatimWord[] = [{ word: 'first', start: 1.0, end: 1.4 }, { word: 'second', start: 5.0, end: 5.4 }]
  const vad = [{ start: 1.4, end: 3.0 }, { start: 3.7, end: 5.0 }] // 0.7s island [3.0,3.7] (uncertain)
  const opt = S({ preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced })
  const res = detectBetaSilencesHybrid(words, [], vad, opt, 6.0)
  const island = res.debug.no_transcript_islands.find((x) => x.where === 'transcript_gap')
  const keeps = keepsFor(words, res.regions)
  const kept = keeps.some((k) => k.start <= 3.35 && k.end >= 3.35)
  check('silence: uncertain no-transcript clip under 2s is removed',
    !!island && island.classification === 'uncertain' && island.decision === 'remove' && !kept,
    `island=${JSON.stringify(island)} kept=${kept}`)
}
// 16. A real speech-like island ≥0.75s CAN be protected (carved AROUND, not cut through).
{
  const words: VerbatimWord[] = [{ word: 'end', start: 1.0, end: 1.3 }, { word: 'so', start: 6.0, end: 6.3 }]
  const vad = [{ start: 1.3, end: 3.0 }, { start: 4.0, end: 6.0 }] // 1.0s island [3.0,4.0] = possible missed speech
  const opt = S({ preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced, maxCutsPerMinute: 60 })
  const res = detectBetaSilencesHybrid(words, [], vad, opt, 7.0)
  const island = res.debug.no_transcript_islands.find((x) => x.where === 'transcript_gap')
  const coversIsland = res.regions.some((r) => r.start < 4.0 - 0.05 && r.end > 3.0 + 0.05)
  check('silence: real speech-like island ≥0.75s is protected (carved around, not cut through)',
    !!island && island.classification === 'protected_speech' && island.decision === 'keep' && !coversIsland && res.debug.speech_islands_protected >= 1,
    `island=${JSON.stringify(island)} coversIsland=${coversIsland} protected=${res.debug.speech_islands_protected}`)
}
// 17. A long (>2s) silent transcript GAP is still shortened normally (rule: a long
//     section IS removable when it is a transcript-gap silence — only NOISE-island
//     classification is new; normal pause-shortening is unchanged).
{
  const words: VerbatimWord[] = [{ word: 'alpha', start: 1.0, end: 1.4 }, { word: 'omega', start: 4.5, end: 4.9 }]
  const vad = [{ start: 1.4, end: 4.5 }] // whole 3.1s gap is genuine silence (no island)
  const opt = S({ preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced })
  const res = detectBetaSilencesHybrid(words, [], vad, opt, 6.0)
  const removed = res.regions.reduce((n, r) => n + (r.end - r.start), 0)
  const gapIslands = res.debug.no_transcript_islands.filter((x) => x.where === 'transcript_gap').length
  check('silence: a long (>2s) silent transcript gap is still shortened (not noise-classified)',
    res.regions.length === 1 && removed > 2.0 && gapIslands === 0,
    `regions=${res.regions.length} removed=${removed.toFixed(2)} gapIslands=${gapIslands}`)
}

// 18. Click GLUED to a word's kept guard air (record-button click right after an
//     isolated word like "Do") is trimmed out of the guard — not left on the
//     timeline — without clipping the word. This is the "Do" case from the field.
{
  const words: VerbatimWord[] = [{ word: 'Do', start: 1.0, end: 1.8 }, { word: 'you', start: 6.0, end: 6.3 }]
  const vad = [{ start: 2.1, end: 6.0 }] // 0.3s click at [1.8,2.1] right after "Do" (non-silence), then silence
  const opt = S({ preset: 'balanced', ...RETAKE_BETA_SILENCE_PRESETS.balanced, maxCutsPerMinute: 60 })
  const res = detectBetaSilencesHybrid(words, [], vad, opt, 7.0)
  const guard = res.debug.no_transcript_islands.find((x) => x.where === 'trail_guard')
  const keeps = keepsFor(words, res.regions)
  const clickKept = keeps.some((k) => k.start <= 1.95 && k.end >= 1.95) // the click's midpoint
  const wordKept = keeps.some((k) => k.start <= 1.0 + 1e-6 && k.end >= 1.79) // "Do" not clipped
  check('silence: a click in a word\'s kept guard air is trimmed out (the "Do" case)',
    !!guard && guard.decision === 'remove' && !clickKept && wordKept,
    `guard=${JSON.stringify(guard)} clickKept=${clickKept} wordKept=${wordKept}`)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall retake-aware checks green')
process.exit(failures ? 1 : 0)
