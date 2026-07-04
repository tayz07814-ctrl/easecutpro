// Regression for the word-cut pad clamp: cutting "and and" out of
// "chipotle and and and my" must NOT clip the neighbouring kept words
// (previously the unconditional 100ms pad ate "…d" of the kept "and" and the
// tail of "chipotle"). Run: npx tsx scripts/verify-wordpad.ts
import { computeKeepRanges } from '../src/shared/edit'
import { createEmptyProject } from '../src/shared/project'
import type { Word } from '../src/shared/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}

const words: Word[] = [
  { id: 'w0', text: 'chipotle', start: 1.0, end: 1.5 },
  { id: 'w1', text: 'and', start: 1.55, end: 1.65, deleted: true },
  { id: 'w2', text: 'and', start: 1.7, end: 1.8, deleted: true },
  { id: 'w3', text: 'and', start: 1.85, end: 1.95 },
  { id: 'w4', text: 'my', start: 2.0, end: 2.2 },
  // wide-gap case: lonely deleted word with >200ms of air on both sides
  { id: 'w5', text: 'um', start: 4.0, end: 4.2, deleted: true },
  { id: 'w6', text: 'so', start: 5.0, end: 5.2 }
]

const p = createEmptyProject('t')
p.media = { path: 'x', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true }
p.transcript = { segments: [{ id: 's0', start: 0, end: 10, words }], words }

const keeps = computeKeepRanges(p)
console.log('  keeps:', JSON.stringify(keeps.map((k) => [Number(k.start.toFixed(3)), Number(k.end.toFixed(3))])))

const covered = (t: number): boolean => keeps.some((k) => t >= k.start && t <= k.end)
check('tail of kept "chipotle" survives (1.5s)', covered(1.5))
check('kept third "and" fully survives (1.85–1.95s)', covered(1.85) && covered(1.95))
check('deleted "and and" actually cut (1.66–1.79s gone)', !covered(1.66) && !covered(1.79))
check('tight-gap pad = midpoint (cut starts ≥1.525, ends ≤1.825)', (() => {
  const cutStart = keeps.find((k) => k.start <= 1.0)!.end
  const cutEnd = keeps.find((k) => k.end >= 1.95 && k.start < 4)!.start
  return cutStart >= 1.525 - 1e-6 && cutStart <= 1.55 + 1e-6 && cutEnd >= 1.8 - 1e-6 && cutEnd <= 1.825 + 1e-6
})())
check('wide-gap word still gets the full 100ms pad (3.9–4.3 cut)', !covered(3.95) && !covered(4.25))

console.log(ok ? '\nWORDPAD OK' : '\nWORDPAD FAILED')
process.exit(ok ? 0 : 1)
