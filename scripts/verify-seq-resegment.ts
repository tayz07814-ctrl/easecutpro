// Verify per-clip transcript/silence re-splitting after combining montage audio.
// Run: npx tsx scripts/verify-seq-resegment.ts
import { splitTranscriptBySequence, splitSilencesBySequence } from '../src/shared/edit'
import type { SequenceClip, Transcript, Word, SilenceRegion } from '../src/shared/types'

const clip = (id: string, inS: number, outS: number): SequenceClip => ({
  id, sourcePath: id + '.mp4', name: id, sourceIn: inS, sourceOut: outS, sourceDuration: outS + 5,
  hasAudio: true, srcW: 1080, srcH: 1920, fps: 30
})
// c1 combined window [0,10); c2 combined window [10,30) (dur 20, sourceIn 5)
const clips = [clip('c1', 0, 10), clip('c2', 5, 25)]
const w = (id: string, t: string, s: number, e: number): Word => ({ id, text: t, start: s, end: e })

// combined-time transcript with a segment fully in c1 and a segment straddling the
// c1/c2 boundary (w3 spans 9.5–10.5, midpoint 10.0 -> c2).
const transcript: Transcript = {
  words: [w('1', 'a', 2, 3), w('2', 'b', 4, 5), w('3', 'straddle', 9.5, 10.5), w('4', 'd', 12, 13)],
  segments: [
    { id: 's1', start: 2, end: 5, words: [w('1', 'a', 2, 3), w('2', 'b', 4, 5)] },
    { id: 's2', start: 9.5, end: 13, words: [w('3', 'straddle', 9.5, 10.5), w('4', 'd', 12, 13)] }
  ]
}

let ok = true
const check = (n: string, c: boolean): void => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) ok = false }

const tmap = splitTranscriptBySequence(transcript, clips)
const t1 = tmap.get('c1')!, t2 = tmap.get('c2')!
console.log('  c1 words:', t1.words.map((x) => `${x.text}[${x.start},${x.end}]`).join(' '))
console.log('  c2 words:', t2.words.map((x) => `${x.text}[${x.start.toFixed(1)},${x.end.toFixed(1)}]`).join(' '))
check('every word lands in exactly one clip (total preserved)', t1.words.length + t2.words.length === 4)
check('c1 has a,b (2 words)', t1.words.length === 2 && t1.words[0].text === 'a')
check('c2 has straddle,d (2 words)', t2.words.length === 2 && t2.words[0].text === 'straddle')
check('all c1 words within [0,10]', t1.words.every((x) => x.start >= 0 && x.end <= 10))
check('all c2 words within [5,25]', t2.words.every((x) => x.start >= 5 && x.end <= 25))
check('c2 word b rebased: d combined 12-13 -> local 7-8', Math.abs(t2.words[1].start - 7) < 0.01 && Math.abs(t2.words[1].end - 8) < 0.01)
check('straddler assigned to c2 by midpoint, clamped to sourceIn 5', t2.words[0].start >= 5 - 1e-6)
check('segments preserved per clip (c1:1, c2:1)', t1.segments.length === 1 && t2.segments.length === 1)

const regions: SilenceRegion[] = [
  { id: 'r1', start: 3, end: 4, action: 'remove' },   // c1 -> local 3-4
  { id: 'r2', start: 11, end: 14, action: 'remove' }  // c2 -> local 6-9
]
const smap = splitSilencesBySequence(regions, clips)
console.log('  c1 silences:', JSON.stringify(smap.get('c1')!.map((r) => [r.start, r.end])))
console.log('  c2 silences:', JSON.stringify(smap.get('c2')!.map((r) => [r.start, r.end])))
check('silence r1 -> c1 [3,4]', smap.get('c1')!.length === 1 && Math.abs(smap.get('c1')![0].start - 3) < 0.01)
check('silence r2 -> c2 [6,9]', smap.get('c2')!.length === 1 && Math.abs(smap.get('c2')![0].start - 6) < 0.01)

console.log(ok ? '\nRESEGMENT OK' : '\nRESEGMENT FAILED')
process.exit(ok ? 0 : 1)
