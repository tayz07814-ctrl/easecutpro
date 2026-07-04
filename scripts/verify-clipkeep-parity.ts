// Parity guard for clipKeepRanges after moving it verbatim ffmpeg.ts -> shared/edit.ts.
// Run: npx tsx scripts/verify-clipkeep-parity.ts
import { clipKeepRanges } from '../src/shared/edit'
import type { SequenceClip, Word } from '../src/shared/types'

const w = (id: string, t: string, s: number, e: number, deleted = false): Word => ({ id, text: t, start: s, end: e, deleted })

// clip trimmed to [1,10]; one word deleted at [3,4] -> cut padded 0.1 each side -> [2.9,4.1]
const clip: SequenceClip = {
  id: 'c1', sourcePath: 'x.mp4', name: 'c1', sourceIn: 1, sourceOut: 10, sourceDuration: 12,
  hasAudio: true, srcW: 1080, srcH: 1920, fps: 30,
  transcript: {
    segments: [],
    words: [w('1', 'hello', 1.2, 2.8), w('2', 'um', 3.0, 4.0, true), w('3', 'world', 4.2, 9.5)]
  },
  silences: [], manualCuts: []
}

const out = clipKeepRanges(clip)
console.log('clipKeepRanges:', out.map((r) => `[${r.start.toFixed(2)},${r.end.toFixed(2)}]`).join(' '))

// invariants + expected snapshot
let ok = true
const within = out.every((r) => r.start >= 1 - 1e-6 && r.end <= 10 + 1e-6)
const monotonic = out.every((r, i) => i === 0 || r.start >= out[i - 1].end - 1e-6)
const nonEmpty = out.every((r) => r.end - r.start > 0.05)
const expect = [{ start: 1, end: 2.9 }, { start: 4.1, end: 10 }]
const matches = out.length === expect.length && out.every((r, i) =>
  Math.abs(r.start - expect[i].start) < 0.02 && Math.abs(r.end - expect[i].end) < 0.02)

for (const [name, cond] of [['within [1,10]', within], ['monotonic', monotonic], ['non-empty', nonEmpty], ['matches expected [1,2.9]+[4.1,10]', matches]] as const) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
console.log(ok ? '\nPARITY OK' : '\nPARITY FAILED')
process.exit(ok ? 0 : 1)
