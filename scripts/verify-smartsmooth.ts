// Headless tests for the Smart Smooth Cut decision system (pure module).
// Run: npx tsx scripts/verify-smartsmooth.ts
import {
  buildPauseCandidates,
  applyRules,
  fallbackDecisions,
  validateAiDecisions,
  finalizeDecisions,
  runSmartSmoothCut,
  SMART_CUT_PRESETS
} from '../src/shared/smartsmooth'
import type { Word, Waveform } from '../src/shared/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}

/** Build words from [text, start, end] triples. */
const W = (triples: [string, number, number][]): Word[] =>
  triples.map(([text, start, end], i) => ({ id: `w${i}`, text, start, end }))

// Speech everywhere except a quiet dip 10..12s (the long pause).
const wf: Waveform = {
  peaksPerSec: 10,
  peaks: Array.from({ length: 300 }, (_, i) => (i >= 100 && i < 120 ? 0.02 : 0.5))
}

// ---------------------------------------------------------------------------
console.log('1) pause candidates from transcript word gaps')
const words1 = W([
  ['Hello', 0.0, 0.4],
  ['world.', 0.5, 0.9], // 100ms gap -> ignored (<300ms)
  ['This', 1.4, 1.7], // 500ms gap -> candidate
  ['is', 1.75, 1.9],
  ['a', 1.95, 2.05],
  ['test.', 2.1, 2.5],
  ['Next', 5.0, 5.4] // 2500ms gap -> candidate (dead air)
])
const cands1 = buildPauseCandidates(words1, [], wf)
check('two candidates found (500ms + 2500ms gaps)', cands1.length === 2)
check('durations measured from word timestamps', cands1[0]?.duration_ms === 500 && cands1[1]?.duration_ms === 2500)
check('sentence boundary detected on "test."', cands1[1]?.sentence_boundary === true)
check('no candidate intrudes into a word', cands1.every((c) => words1.every((w) => c.end <= w.start + 1e-6 || c.start >= w.end - 1e-6)))

// ---------------------------------------------------------------------------
console.log('2) rules: keep very short pauses / cut long dead air')
const preset = SMART_CUT_PRESETS.tiktok_smooth
const r1 = applyRules(cands1, preset)
const d500 = r1.decisions.find((d) => d.pause_id === cands1[0].pause_id)
check('500ms pause kept', d500?.decision === 'keep')
const isAmbiguous2500 = r1.ambiguous.some((c) => c.pause_id === cands1[1].pause_id)
const d2500 = r1.decisions.find((d) => d.pause_id === cands1[1].pause_id)
check('2500ms pause shortened or judged (never silently kept)', d2500?.decision === 'shorten' || isAmbiguous2500)

// ---------------------------------------------------------------------------
console.log('3) VAD is a candidate detector only (clamped to word gaps)')
const cands3 = buildPauseCandidates(words1, [{ start: 2.0, end: 5.2 }], wf) // VAD overlaps words a/test + gap
const vadCand = cands3.find((c) => c.source !== 'word_gap')
check('VAD region merged/clamped, never inside a word', !vadCand || (vadCand.start >= 2.5 && vadCand.end <= 5.0))
check('overlapping gap tagged as both/word_gap', cands3.some((c) => c.source === 'both' || c.source === 'word_gap'))

// ---------------------------------------------------------------------------
console.log('4) AI judge: invalid JSON falls back safely')
check('garbage -> []', validateAiDecisions('LOL not json', cands1).length === 0)
check('unknown ids dropped', validateAiDecisions('{"decisions":[{"pause_id":"nope","decision":"remove"}]}', cands1).length === 0)
const clamped = validateAiDecisions(
  `{"decisions":[{"pause_id":"${cands1[1].pause_id}","decision":"shorten","keep_ms":999999,"reason":"x"}]}`,
  cands1
)
check('impossible keep_ms clamped below pause duration', clamped[0]?.keep_ms != null && clamped[0].keep_ms! < 2500)
const fb = fallbackDecisions(r1.ambiguous, preset)
check('fallback covers all ambiguous pauses', fb.length === r1.ambiguous.length)

// ---------------------------------------------------------------------------
console.log('5) finalize: valid timeline, padding, guards')
const all1 = [...r1.decisions, ...fb]
const fin1 = finalizeDecisions(cands1, all1, preset, words1, [])
check('regions stay inside their pauses', fin1.silenceAdds.every((r) => cands1.some((c) => r.start >= c.start - 1e-6 && r.end <= c.end + 1e-6)))
check('remove regions leave speech padding', fin1.silenceAdds.filter((r) => r.action === 'remove').every((r) => cands1.some((c) => r.start >= c.start + preset.speech_pad_end_ms / 1000 - 1e-6)))
check('timestamps valid (start<end, no overlap)', fin1.silenceAdds.every((r, i, a) => r.start < r.end && (i === 0 || r.start >= a[i - 1].end)))

// ---------------------------------------------------------------------------
console.log('6) retake restart: reset pause collapsed + earlier attempt flagged')
const words2 = W([
  ['so', 0.0, 0.2],
  ['i', 0.25, 0.35],
  ['went', 0.4, 0.7],
  ['to', 0.75, 0.85], // speaker abandons here…
  ['so', 1.8, 2.0], // …950ms reset pause, then restarts
  ['i', 2.05, 2.15],
  ['went', 2.2, 2.5],
  ['to', 2.55, 2.65],
  ['the', 2.7, 2.8],
  ['store', 2.85, 3.3]
])
const res2 = await runSmartSmoothCut({
  words: words2,
  vad: [],
  waveform: null,
  preset: 'tiktok_smooth',
  existingSilences: [],
  videoDuration: 4
})
check('restart pause shortened/removed', res2.silenceAdds.length >= 1)
check('earlier failed attempt words flagged', res2.retakeWordIds.length >= 3)
check('debug JSON has candidates + decisions + timeline', res2.debug.pause_candidates.length > 0 && res2.debug.rule_decisions.length > 0 && Array.isArray(res2.debug.final_cut_timeline))

// ---------------------------------------------------------------------------
console.log('7) whole pipeline survives with NO AI judge + NO waveform + NO VAD')
const res3 = await runSmartSmoothCut({
  words: words1,
  vad: [],
  waveform: null,
  preset: 'tiktok_smooth',
  existingSilences: [],
  videoDuration: 6
})
check('completes rules-only', res3.decisions.length > 0)
check('warnings mention missing waveform/VAD', res3.debug.warnings.length >= 2)

// ---------------------------------------------------------------------------
console.log('8) AI judge that throws does not crash the run')
// A 1200ms sentence-boundary pause with non-low energy = ambiguous -> judge runs.
const words8 = W([
  ['Wow.', 0.0, 0.5],
  ['That', 1.7, 2.0],
  ['was', 2.05, 2.2],
  ['wild', 2.25, 2.6]
])
const res4 = await runSmartSmoothCut({
  words: words8,
  vad: [],
  waveform: wf,
  preset: 'natural',
  existingSilences: [],
  videoDuration: 3,
  aiJudge: async () => {
    throw new Error('provider down')
  }
})
check('run completes with judge failure', Array.isArray(res4.silenceAdds))
check('failure recorded in warnings', res4.debug.warnings.some((w) => w.includes('AI judge failed')))

// ---------------------------------------------------------------------------
console.log('8b) contiguous whisper words: VAD-anchored pauses still found')
// whisper.cpp style: each word's end == next word's start (pause swallowed by
// the word span). The 1.5s pause after "because" (2.0..3.5) only shows in VAD.
const wordsC = W([
  ['So', 0.0, 0.4],
  ['because', 0.4, 3.5], // span swallows the real 1.3s pause
  ['I', 3.5, 3.7],
  ['went', 3.7, 4.0]
])
const candsC = buildPauseCandidates(wordsC, [{ start: 2.1, end: 3.5 }], null)
check('VAD pause inside the word span becomes a candidate', candsC.some((c) => c.source === 'vad' && c.duration_ms >= 1000))
check('candidate never bites the spoken head (starts >= word.start+0.12)', candsC.filter((c) => c.source === 'vad').every((c) => c.start >= 0.52))

console.log('9) existing user silences are never overridden')
const res5 = await runSmartSmoothCut({
  words: words1,
  vad: [],
  waveform: wf,
  preset: 'aggressive',
  existingSilences: [{ id: 'user1', start: 2.5, end: 5.0, action: 'remove' }],
  videoDuration: 6
})
check('smart regions skip user-owned ranges', res5.silenceAdds.every((r) => !(r.start < 5.0 && 2.5 < r.end)))

console.log(ok ? '\nSMARTSMOOTH OK' : '\nSMARTSMOOTH FAILED')
process.exit(ok ? 0 : 1)
