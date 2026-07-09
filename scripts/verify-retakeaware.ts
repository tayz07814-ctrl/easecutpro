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
import { detectBetaSilencesHybrid } from '../src/shared/retakeaware/silence'
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

// ---- Retake β HYBRID silence (detectBetaSilencesHybrid) ----
// Words: `before` phrase, a `gap`-second pause, then `after` phrase. Intra-phrase
// gaps are tiny (<0.85s) so only the pause becomes a candidate.
function betaScene(before: string, gap: number, after: string): { words: VerbatimWord[]; prevEnd: number; nextStart: number } {
  const words: VerbatimWord[] = []
  let t = 0.5
  for (const tok of before.split(/\s+/).filter(Boolean)) { words.push({ word: tok, start: t, end: t + 0.2 }); t += 0.26 }
  const prevEnd = words[words.length - 1].end
  t = prevEnd + gap
  const nextStart = t
  for (const tok of after.split(/\s+/).filter(Boolean)) { words.push({ word: tok, start: t, end: t + 0.2 }); t += 0.26 }
  return { words, prevEnd, nextStart }
}
const L = 0.22, LF = 0.32, R = 0.28, RF = 0.38
const run = (before: string, gap: number, after: string, vad: { start: number; end: number }[] = [], cuts: CutSpan[] = []) => {
  const s = betaScene(before, gap, after)
  const res = detectBetaSilencesHybrid(s.words, cuts, vad)
  return { s, res, region: res.regions[0], rec: res.debug.per_region.find((r) => Math.abs(r.transcript_gap_duration - gap) < 0.01) }
}
const BEFORE = 'this is a perfectly normal clean sentence'
const AFTER = 'results were great here today'

// 1 & 2. Breaths (0.2s, 0.5s) ignored (under 0.85s min gap).
for (const g of [0.2, 0.5]) {
  const { res, rec } = run(BEFORE, g, AFTER)
  check(`hybrid silence: ${g}s breath ignored (under min gap)`, res.regions.length === 0 && !!rec && rec.dropped_under_min_gap)
}
// 3. 1.4s gap → residual ~0.5–0.7s.
{
  const { region, s } = run(BEFORE, 1.4, AFTER)
  const residual = region ? 1.4 - (region.end - region.start) : 0
  check('hybrid silence: 1.4s gap tightens to ~0.5–0.7s residual', !!region && residual >= 0.5 - 1e-6 && residual <= 0.7 + 1e-6 && region.start > s.prevEnd && region.end < s.nextStart, `residual=${residual.toFixed(3)}`)
}
// 4. 2s gap → residual ~0.5–0.7s.
{
  const { region } = run(BEFORE, 2.0, AFTER)
  const residual = region ? 2.0 - (region.end - region.start) : 0
  check('hybrid silence: 2s gap tightens to ~0.5–0.7s residual', !!region && residual >= 0.5 - 1e-6 && residual <= 0.7 + 1e-6, `residual=${residual.toFixed(3)}`)
}
// 5. 5s dead air → trimmed, natural residual (~0.7–0.9s).
{
  const { region } = run(BEFORE, 5.0, AFTER)
  const residual = region ? 5.0 - (region.end - region.start) : 0
  check('hybrid silence: 5s dead air leaves a natural ~0.7–0.9s residual', !!region && residual >= 0.7 - 1e-6 && residual <= 0.9 + 1e-6, `residual=${residual.toFixed(3)}`)
}
// 6. Last word before pause not clipped.
{
  const { region, s } = run(BEFORE, 2.0, AFTER)
  check('hybrid silence: last word before pause not clipped', !!region && region.start >= s.prevEnd + L - 1e-6)
}
// 7. First word after pause not clipped.
{
  const { region, s } = run(BEFORE, 2.0, AFTER)
  check('hybrid silence: first word after pause not clipped', !!region && region.end <= s.nextStart - R + 1e-6)
}
// 8. Fragile next starter "it" gets the larger right guard.
{
  const { region, s, rec } = run('everything turned out really nicely here today', 2.0, 'it is a very good result')
  check('hybrid silence: fragile next word "it" protected (380ms)', !!region && rec!.right_guard_ms === RF * 1000 && region.end <= s.nextStart - RF + 1e-6)
}
// 9. VAD UNDER-detection (no silence found) must NOT cause 1–3s leftover.
{
  const { region } = run(BEFORE, 3.0, AFTER, []) // VAD found nothing → transcript gap still drives removal
  const residual = region ? 3.0 - (region.end - region.start) : 99
  check('hybrid silence: VAD under-detection does NOT leave 1–3s (transcript gap drives removal)', !!region && residual < 1.0, `residual=${residual.toFixed(3)}`)
}
// 10. Real speech island INSIDE the proposed centre → drop.
{
  const first = run(BEFORE, 3.0, AFTER, []) // get the proposed cut with no VAD
  const c = first.region!
  // VAD silence covers the centre EXCEPT a 0.4s speech island in its middle.
  const mid = (c.start + c.end) / 2
  const vad = [{ start: 0, end: mid - 0.2 }, { start: mid + 0.2, end: 1000 }]
  const { res, rec } = run(BEFORE, 3.0, AFTER, vad)
  check('hybrid silence: real speech island inside centre → dropped', res.regions.length === 0 && !!rec && rec.dropped_due_to_vad_speech_inside_center)
}
// 11. Candidate overlapping a word cut is dropped.
{
  const s = betaScene(BEFORE, 2.0, AFTER)
  const wordCut: CutSpan = { start: s.prevEnd - 0.1, end: s.prevEnd + 1.0, type: 'failed_retake', source: 'retake_aware_beta', reason: 'x' }
  const res = detectBetaSilencesHybrid(s.words, [wordCut], [])
  check('hybrid silence: candidate overlapping a word cut is dropped', res.regions.length === 0 && res.debug.per_region.some((r) => r.dropped_due_to_word_cut_overlap))
}
// 12. computeKeepRanges applies the protected region verbatim (no snap/absorb).
{
  const { region, s } = run(BEFORE, 2.5, AFTER)
  const dur = s.nextStart + 2.0
  const pps = 200
  const peaks = new Array(Math.ceil(dur * pps)).fill(0.02)
  for (const w of s.words) for (let i = Math.floor(w.start * pps); i < Math.ceil(w.end * pps); i++) peaks[i] = 0.4
  peaks[Math.floor((s.prevEnd + 0.05) * pps)] = 0.0 // valley inside left guard (would tempt a snap)
  peaks[Math.floor((s.nextStart - 0.05) * pps)] = 0.0
  const project = {
    version: 1, name: 't', media: { path: 'x', duration: dur } as any,
    transcript: { words: s.words.map((w, i) => ({ id: `w${i}`, text: w.word, start: w.start, end: w.end, deleted: false })), segments: [] },
    silences: [region] as SilenceRegion[], tracks: [], playhead: 0, pxPerSec: 80, magnet: false, trackHeight: 90,
    baseSplits: [], manualCuts: [], keepOverrides: [], silencePadding: 0.08, showThumbnails: true, texts: [], aspectW: 0, aspectH: 0
  } as unknown as Project
  const keeps = computeKeepRanges(project, { peaksPerSec: pps, peaks })
  const exact = keeps.some((k) => Math.abs(k.end - region!.start) < 0.01) && keeps.some((k) => Math.abs(k.start - region!.end) < 0.01)
  check('hybrid silence: computeKeepRanges preserves protected boundary verbatim', exact, `keeps=${keeps.map((k) => `[${k.start.toFixed(2)},${k.end.toFixed(2)}]`).join(' ')}`)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall retake-aware checks green')
process.exit(failures ? 1 : 0)
