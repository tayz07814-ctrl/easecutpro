// Headless tests for the CutCutPro pure logic (shared/cutcutpro.ts).
// Run: npx tsx scripts/verify-cutcutpro.ts
import { buildTimestampMap, buildAiPayload, validateEdl, refineEdl, edlToEdits, type Edl } from '../src/shared/cutcutpro'
import type { Word } from '../src/shared/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}

const W = (triples: [string, number, number][]): Word[] =>
  triples.map(([text, start, end], i) => ({ id: `w${i}`, text, start, end }))

// "Um, so I went to— (pause 900ms) so I went to the store. (pause 2s) Great."
const words = W([
  ['Um,', 0.0, 0.25],
  ['so', 0.3, 0.45],
  ['I', 0.5, 0.6],
  ['went', 0.65, 0.9],
  ['to—', 0.95, 1.1],
  ['so', 2.0, 2.15], // 900ms reset pause before this
  ['I', 2.2, 2.3],
  ['went', 2.35, 2.6],
  ['to', 2.65, 2.75],
  ['the', 2.8, 2.9],
  ['store.', 2.95, 3.4],
  ['Great.', 5.4, 5.8] // 2s dead air before this
])

console.log('1) timestamp map: pauses, fillers, incomplete sentences')
const map = buildTimestampMap(words, [{ start: 3.4, end: 5.4 }])
check('two pauses mapped (900ms + 2000ms)', map.pauses.length === 2)
check('exact pause durations', map.pauses[0].dur_ms === 900 && map.pauses[1].dur_ms === 2000)
check('VAD corroboration flagged on the 2s pause', map.pauses[1].vad === true && map.pauses[0].vad === false)
check('"Um," flagged as filler', map.filler_word_idxs.includes(0))
check('incomplete sentence flagged ("to—" before the reset)', map.incomplete_sentences.some((s) => s.end_word === 4))

console.log('1b) contiguous whisper words: VAD-anchored pauses still mapped')
const wordsC = W([
  ['So', 0.0, 0.4],
  ['because', 0.4, 3.5], // whisper.cpp span swallows the real pause
  ['I', 3.5, 3.7]
])
const mapC = buildTimestampMap(wordsC, [{ start: 2.1, end: 3.5 }])
check('VAD pause inside the word span mapped', mapC.pauses.some((p) => p.vad && p.after_word === 1 && p.dur_ms >= 1000))
check('pause never bites the spoken head', mapC.pauses.filter((p) => p.vad).every((p) => p.start >= 0.52))
check('gap-less transcript without VAD still yields no fake pauses', buildTimestampMap(wordsC, []).pauses.length === 0)

console.log('2) AI payload is index-anchored')
const payload = buildAiPayload(map)
check('contains indexed words and pause ids', payload.includes('4|to—') && payload.includes('p0: pause 900ms'))

console.log('3) EDL validation: clamping + garbage + runaway')
check('garbage -> not ok', validateEdl('sorry I cannot', map).ok === false)
const v1 = validateEdl('{"word_cuts":[{"from":-5,"to":900,"reason":"x"}],"pause_cuts":[{"pause_id":"p1","keep_ms":99999}]}', map)
check('indices clamped into range', v1.ok === false || v1.edl.word_cuts[0].from === 0)
const vRunaway = validateEdl(
  JSON.stringify({ word_cuts: [{ from: 0, to: 24, reason: 'cut everything' }], pause_cuts: [] }),
  buildTimestampMap(W(Array.from({ length: 30 }, (_, i) => [`w${i}`, i, i + 0.5] as [string, number, number])), [])
)
check('runaway EDL (cuts >60% of words) rejected', vRunaway.ok === false)
const v2 = validateEdl(
  '```json\n{"word_cuts":[{"from":0,"to":0,"reason":"filler"},{"from":1,"to":4,"reason":"failed take"}],"pause_cuts":[{"pause_id":"p0","keep_ms":0,"reason":"reset"},{"pause_id":"p1","keep_ms":250,"reason":"dead air"}]}\n```',
  map
)
check('fenced JSON accepted', v2.ok === true && v2.edl.word_cuts.length === 2 && v2.edl.pause_cuts.length === 2)
check('keep_ms clamped below pause duration', v2.edl.pause_cuts.every((c) => c.keep_ms < 2000))

console.log('4) EDL -> edits on the existing model')
const edits = edlToEdits(v2.edl, map, words)
check('failed take words deleted (Um + so I went to—)', edits.deleteWordIds.length === 5 && edits.deleteWordIds.includes('w4'))
check('remove region keeps 80ms breath pads', (() => {
  const r = edits.silenceAdds.find((x) => x.action === 'remove')
  return !!r && r.start >= 1.1 + 0.08 - 1e-6 && r.end <= 2.0 - 0.08 + 1e-6
})())
check('shorten region carries shortenTo', edits.silenceAdds.some((x) => x.action === 'shorten' && Math.abs((x.shortenTo ?? 0) - 0.25) < 1e-6))
check('regions sorted and valid', edits.silenceAdds.every((r, i, a) => r.start < r.end && (i === 0 || r.start >= a[i - 1].end)))

console.log('5) empty EDL is a safe no-op')
const none = edlToEdits({ word_cuts: [], pause_cuts: [] }, map, words)
check('no edits produced', none.deleteWordIds.length === 0 && none.silenceAdds.length === 0)

// ---------------------------------------------------------------------------
// refineEdl — screenshot regression: partial retake cuts must be extended.
// ---------------------------------------------------------------------------
const sent = (texts: string[], t0: number, gapAt?: number, gapLen = 1.0): [string, number, number][] => {
  const out: [string, number, number][] = []
  let t = t0
  texts.forEach((x, i) => {
    if (gapAt !== undefined && i === gapAt) t += gapLen
    out.push([x, t, t + 0.25])
    t += 0.3
  })
  return out
}
const keptText = (edl: Edl, ws: Word[]): string => {
  const cut = new Set<number>()
  for (const c of edl.word_cuts) for (let i = c.from; i <= c.to; i++) cut.add(i)
  return ws.filter((_, i) => !cut.has(i)).map((w) => w.text).join(' ')
}

console.log('6) SS1: duplicated opening extended back ("But I wish I grabbed two because…")')
const ss1 = W(sent(
  ['But', 'I', 'wish', 'I', 'grabbed', 'two', 'because', 'I', 'have', 'to', 'wait', 'a', 'freaking.',
   'I', 'wish', 'I', 'grabbed', 'two', 'because', 'I', 'literally', 'have', 'to', 'wait', 'two', 'weeks.'],
  0, 7, 1.7
))
const map1 = buildTimestampMap(ss1, [])
// AI only cut the tail "I have to wait a freaking." (words 7..12)
const r1 = refineEdl({ word_cuts: [{ from: 7, to: 12, reason: 'tail' }], pause_cuts: [] }, map1)
const kept1 = keptText(r1.edl, ss1)
check('doomed opening swallowed', !/because I wish/i.test(kept1) && /But I wish I grabbed two because I literally/i.test(kept1))
check('note recorded', r1.notes.some((n) => n.startsWith('dedupe')))

console.log('7) SS3: boundary one word off ("do | not be surprised")')
const ss3 = W(sent(
  ['Like,', 'do', 'not', 'be', 'surprised', 'if', "you're", 'got', 'or', 'do',
   'not', 'be', 'surprised', 'if', 'your', "man's", 'wants', 'to', 'live', 'up.'],
  0, 5, 1.5
))
const map3 = buildTimestampMap(ss3, [])
// AI cut "if you're got or do" (5..9) — swallowing the restart's "do"
const r3 = refineEdl({ word_cuts: [{ from: 5, to: 9, reason: 'garble' }], pause_cuts: [] }, map3)
const kept3 = keptText(r3.edl, ss3)
check('no duplicated "not be surprised"', !/surprised.*surprised/i.test(kept3.replace(/\n/g, ' ')) || /Like, do not be surprised if your/i.test(kept3))
check('reads fluently', /Like, do not be surprised if your man's/i.test(kept3) || /Like, do.*not be surprised if your/i.test(kept3))

console.log('8) SS2: dangling incomplete clause swept ("because it smell so …")')
const ss2 = W(sent(
  ['so', 'freaking', 'cheap.',
   'I', "don't", 'want', 'to', 'hear', 'none', 'of', "y'all", 'saying', 'this', "isn't", 'affordable', 'because', 'it', 'smell', 'so',
   'freaking.',
   'It', 'smells', 'so', 'good,', 'you', 'think.'],
  0, 19, 0.9
))
const map2 = buildTimestampMap(ss2, [])
check('fragment flagged by the map', map2.incomplete_sentences.some((s) => s.end_word === 18))
// AI only cut "freaking." (word 19)
const r2 = refineEdl({ word_cuts: [{ from: 19, to: 19, reason: 'tail word' }], pause_cuts: [] }, map2)
const kept2 = keptText(r2.edl, ss2)
check('broken clause fully removed', !/because it smell so\s+It smells/i.test(kept2) && !/affordable because it smell so/i.test(kept2))
check('surrounding sentences intact', /so freaking cheap\./i.test(kept2) && /It smells so good/i.test(kept2))

console.log('9) refineEdl safety: no dupes -> unchanged; runaway reverted')
const plain = W(sent(['One', 'two', 'three.', 'Four', 'five', 'six.'], 0))
const mapP = buildTimestampMap(plain, [])
const rP = refineEdl({ word_cuts: [{ from: 3, to: 3, reason: 'x' }], pause_cuts: [] }, mapP)
check('benign cut untouched', rP.edl.word_cuts.length === 1 && rP.edl.word_cuts[0].from === 3 && rP.edl.word_cuts[0].to === 3)
const big = W(sent(Array.from({ length: 40 }, (_, i) => (i % 4 === 3 ? `w${i}.` : `w${i}`)), 0))
const mapB = buildTimestampMap(big, [])
const rB = refineEdl({ word_cuts: [{ from: 2, to: 30, reason: 'huge' }], pause_cuts: [] }, mapB)
check('runaway refinement reverts to original', rB.edl.word_cuts[0].from === 2 && rB.edl.word_cuts[0].to === 30)

console.log(ok ? '\nCUTCUTPRO OK' : '\nCUTCUTPRO FAILED')
process.exit(ok ? 0 : 1)
