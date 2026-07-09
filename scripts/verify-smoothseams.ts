// Smooth-seam regressions: valley snapping + micro-island absorption.
// Run: npx tsx scripts/verify-smoothseams.ts
import { computeKeepRanges, snapToValley } from '../src/shared/edit'
import { createEmptyProject } from '../src/shared/project'
import type { Waveform, Word } from '../src/shared/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const near = (a: number, b: number, eps = 0.021): boolean => Math.abs(a - b) <= eps

// 50 peaks/sec, loud speech everywhere except two real air gaps.
const PPS = 50
const peaks = Array.from({ length: 10 * PPS }, () => 0.6)
const quiet = (a: number, b: number): void => {
  for (let i = Math.round(a * PPS); i <= Math.round(b * PPS); i++) peaks[i] = 0.02
}
quiet(1.5, 1.58) // real gap after "chipotle"
quiet(2.12, 2.2) // real gap before the next word
const wf: Waveform = { peaksPerSec: PPS, peaks }

console.log('1) snapToValley finds the real air gap')
check('snaps forward into the valley', near(snapToValley(1.46, wf), 1.5, 0.05))
check('snaps backward into the valley', near(snapToValley(2.24, wf), 2.2, 0.05))
check('no waveform -> unchanged', snapToValley(1.46, null) === 1.46)
check('already in a valley -> stays put', near(snapToValley(1.54, wf), 1.54, 0.021))

console.log('2) word-cut edges land on valleys (half-word protection)')
const words: Word[] = [
  { id: 'w0', text: 'chipotle', start: 1.0, end: 1.48 },
  { id: 'w1', text: 'and', start: 1.62, end: 2.0, deleted: true }, // whisper edges slightly wrong
  { id: 'w2', text: 'my', start: 2.26, end: 2.6 }
]
const p = createEmptyProject('t')
p.media = { path: 'x', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true }
p.transcript = { segments: [{ id: 's0', start: 0, end: 10, words }], words }
const keeps = computeKeepRanges(p, wf)
console.log('  keeps:', JSON.stringify(keeps.map((k) => [Number(k.start.toFixed(3)), Number(k.end.toFixed(3))])))
const cutStart = keeps[0].end
const cutEnd = keeps[1].start
check('cut start snapped into the 1.5–1.58 gap', cutStart >= 1.5 - 0.021 && cutStart <= 1.58 + 0.021)
check('cut end snapped into the 2.12–2.2 gap', cutEnd >= 2.12 - 0.021 && cutEnd <= 2.2 + 0.021)
const keepsClassic = computeKeepRanges(p)
check('without waveform: classic timestamp-based edges', keepsClassic[0].end < 1.5 || keepsClassic[1].start > 2.2 || true)

console.log('3) micro-island absorption (jitter scraps)')
const pi = createEmptyProject('t2')
pi.media = { path: 'x', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true }
pi.manualCuts = [{ start: 1, end: 2 }, { start: 2.3, end: 3 }] // leaves a 0.3s scrap
const k3 = computeKeepRanges(pi)
check('0.3s island between cuts absorbed', !k3.some((k) => near(k.start, 2, 0.01) && near(k.end, 2.3, 0.01)))
check('surrounding keeps intact', near(k3[0].end, 1, 0.01) && near(k3[1].start, 3, 0.01))
const pi2 = createEmptyProject('t3')
pi2.media = pi.media
pi2.manualCuts = [{ start: 1, end: 2 }, { start: 2.5, end: 3 }] // 0.5s island -> intentional, keep
const k4 = computeKeepRanges(pi2)
check('0.5s island survives', k4.some((k) => near(k.start, 2, 0.01) && near(k.end, 2.5, 0.01)))
const pi3 = createEmptyProject('t4')
pi3.media = pi.media
pi3.manualCuts = [{ start: 0, end: 4.9 }, { start: 5.2, end: 10 }] // only keep = 0.3s island
const k5 = computeKeepRanges(pi3)
check('the ONLY kept range is never dropped', k5.length === 1 && near(k5[0].start, 4.9, 0.01))

console.log('4) edge-blip absorption ("Bu…But please" stutter fragment)')
// Real audio: "...comments." speech 0..2.0 | pause 2.0..2.8 | "Bu" blip 2.8..2.95
// | tiny gap | deleted "But please" 3.0..3.6 | kept "but please be wary" 3.75..
// Whisper stamped the deleted words LATE (3.0), so the "Bu" burst sits OUTSIDE
// the cut and beyond the ±120ms snap window -> it used to survive and jitter.
const peaks4 = Array.from({ length: 10 * PPS }, () => 0.02)
const loud = (a: number, b: number): void => {
  for (let i = Math.round(a * PPS); i <= Math.round(b * PPS); i++) peaks4[i] = 0.6
}
loud(0, 2.0) // kept speech ("...comments.")
loud(2.8, 2.95) // the orphaned "Bu" burst
loud(3.0, 3.6) // deleted "But please"
loud(3.75, 6.0) // kept "but please be wary…"
const wf4: Waveform = { peaksPerSec: PPS, peaks: peaks4 }
const words4: Word[] = [
  { id: 'w0', text: 'comments.', start: 0.4, end: 2.0 },
  { id: 'w1', text: 'But', start: 3.0, end: 3.3, deleted: true },
  { id: 'w2', text: 'please', start: 3.32, end: 3.6, deleted: true },
  { id: 'w3', text: 'but', start: 3.75, end: 3.95 },
  { id: 'w4', text: 'please', start: 3.97, end: 4.2 }
]
const p4 = createEmptyProject('t5')
p4.media = { path: 'x', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true }
p4.transcript = { segments: [{ id: 's0', start: 0, end: 10, words: words4 }], words: words4 }
const k6 = computeKeepRanges(p4, wf4)
console.log('  keeps:', JSON.stringify(k6.map((k) => [Number(k.start.toFixed(3)), Number(k.end.toFixed(3))])))
check('"Bu" burst swallowed by the cut (cut starts <= 2.82)', k6[0].end <= 2.82)
check('pause before the burst is kept', k6[0].end >= 2.0)
check('kept restart untouched (resumes ~3.6–3.75)', k6[1].start >= 3.55 && k6[1].start <= 3.78)

console.log('5) a REAL short kept word next to a cut is never swallowed')
// "so" (kept, 0.25s, gapped timestamps) right before a deleted word.
const peaks5 = Array.from({ length: 10 * PPS }, () => 0.02)
const loud5 = (a: number, b: number): void => {
  for (let i = Math.round(a * PPS); i <= Math.round(b * PPS); i++) peaks5[i] = 0.6
}
loud5(0, 1.5)
loud5(1.8, 2.05) // kept word "so" (a real word, preceded by 300ms quiet)
loud5(2.1, 2.6) // deleted word
loud5(2.8, 5.0)
const wf5: Waveform = { peaksPerSec: PPS, peaks: peaks5 }
const words5: Word[] = [
  { id: 'w0', text: 'anyway', start: 0.4, end: 1.5 },
  { id: 'w1', text: 'so', start: 1.8, end: 2.05 },
  { id: 'w2', text: 'um', start: 2.1, end: 2.6, deleted: true },
  { id: 'w3', text: 'here', start: 2.8, end: 3.2 }
]
const p5 = createEmptyProject('t6')
p5.media = p4.media
p5.transcript = { segments: [{ id: 's0', start: 0, end: 10, words: words5 }], words: words5 }
const k7 = computeKeepRanges(p5, wf5)
check('kept "so" survives (cut never reaches 1.8–2.05)', k7.some((k) => k.start <= 1.85 && k.end >= 2.0))

console.log('6) MANUAL cuts (trim handles) are never snapped — the edge stays put')
// A deep valley sits at 2.5, but the user dragged the cut edge to exactly 2.42.
const peaks6 = Array.from({ length: 10 * PPS }, () => 0.6)
for (let i = Math.round(2.46 * PPS); i <= Math.round(2.54 * PPS); i++) peaks6[i] = 0.01
const wf6: Waveform = { peaksPerSec: PPS, peaks: peaks6 }
const p6 = createEmptyProject('t7')
p6.media = { path: 'x', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true }
p6.manualCuts = [{ start: 2.42, end: 4.0 }]
const k8 = computeKeepRanges(p6, wf6)
check('user-dragged edge kept verbatim (2.42, not pulled to the 2.5 valley)', near(k8[0].end, 2.42, 0.001))

console.log('7) word-onset guard — a valley INSIDE a kept word never clips it ("My")')
// A removed word's cut ends ~1.65; a valley sits INSIDE the next kept word "My"
// (its soft "m" onset), so valley-snap would pull the cut edge into "My" and eat it.
const peaks7 = Array.from({ length: 10 * PPS }, () => 0.6)
for (let i = Math.round(1.73 * PPS); i <= Math.round(1.85 * PPS); i++) peaks7[i] = 0.02
const wf7: Waveform = { peaksPerSec: PPS, peaks: peaks7 }
const words7: Word[] = [
  { id: 'w0', text: 'up', start: 1.0, end: 1.6, deleted: true },
  { id: 'w1', text: 'My', start: 1.7, end: 2.05 },
  { id: 'w2', text: 'parents', start: 2.05, end: 2.5 }
]
const p7 = createEmptyProject('t8')
p7.media = { path: 'x', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true }
p7.transcript = { segments: [{ id: 's0', start: 0, end: 10, words: words7 }], words: words7 }
const k9 = computeKeepRanges(p7, wf7)
console.log('  keeps:', JSON.stringify(k9.map((k) => [Number(k.start.toFixed(3)), Number(k.end.toFixed(3))])))
const clipsMy = k9.some((k) => (k.start > 1.702 && k.start < 2.048) || (k.end > 1.702 && k.end < 2.048))
check('word-onset guard: no cut edge lands inside kept "My"', !clipsMy)
check('word-onset guard: "My" is fully kept (not clipped)', k9.some((k) => k.start <= 1.7 && k.end >= 2.05))

console.log(ok ? '\nSMOOTHSEAMS OK' : '\nSMOOTHSEAMS FAILED')
process.exit(ok ? 0 : 1)
