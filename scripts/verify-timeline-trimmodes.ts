// Verify roll / slip / slide trims. Run: npx tsx scripts/verify-timeline-trimmodes.ts

import {
  createTimeline,
  createTrack,
  createClip,
  addTrackToDoc,
  addClipToDoc,
  rollEditInDoc,
  slipClipInDoc,
  slideClipInDoc,
  findClip
} from '../src/shared/timeline/model'
import { FPS_30 } from '../src/shared/timeline/time'
import type { TimelineDocument } from '../src/shared/timeline/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps
const clip = (d: TimelineDocument, id: string) => findClip(d, id)!.clip

function track(clips: Array<[string, number, number, number, number]>): TimelineDocument {
  // [id, start, duration, sourceIn, sourceOut]
  let d = createTimeline(FPS_30)
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'V' }))
  for (const [id, start, duration, sin, sout] of clips) {
    d = addClipToDoc(d, createClip({ id, kind: 'video', trackId: 'V', start, duration, sourcePath: id, sourceIn: sin, sourceOut: sout, sourceDuration: 20 }))
  }
  return d
}

// --- roll: move the shared cut A|B left to frame 120 ---
const rollDoc = track([['A', 0, 150, 0, 5], ['B', 150, 120, 2, 6]])
const rolled = rollEditInDoc(rollDoc, 'A', 120, FPS_30)
check('roll: cut moved to 120 (A.end, B.start)', clip(rolled, 'A').end === 120 && clip(rolled, 'B').start === 120)
check('roll: A.sourceOut retracts to 4s', near(clip(rolled, 'A').sourceOut, 4))
check('roll: B.sourceIn extends to 1s', near(clip(rolled, 'B').sourceIn, 1))
check('roll: total span A.start..B.end unchanged (0..270)', clip(rolled, 'A').start === 0 && clip(rolled, 'B').end === 270)

// --- slip: shift A's content +1s, position fixed ---
const slipDoc = track([['A', 0, 150, 0, 5]])
const slipped = slipClipInDoc(slipDoc, 'A', 30, FPS_30)
check('slip: source window shifts +1s -> [1,6]', near(clip(slipped, 'A').sourceIn, 1) && near(clip(slipped, 'A').sourceOut, 6))
check('slip: timeline start/duration unchanged', clip(slipped, 'A').start === 0 && clip(slipped, 'A').duration === 150)

// --- slip clamps at the media head ---
const slipClamp = slipClipInDoc(slipDoc, 'A', -60, FPS_30)
check('slip: clamps at source head (no move past 0)', clip(slipClamp, 'A').sourceIn === 0 && near(clip(slipClamp, 'A').sourceOut, 5))

// --- slide: move B +30f; neighbours absorb it ---
const slideDoc = track([['A', 0, 150, 2, 7], ['B', 150, 120, 2, 6], ['C', 270, 120, 2, 6]])
const slid = slideClipInDoc(slideDoc, 'B', 180, FPS_30)
check('slide: B moved to 180', clip(slid, 'B').start === 180)
check('slide: prev A.out extended to 180', clip(slid, 'A').end === 180 && near(clip(slid, 'A').sourceOut, 8))
check('slide: next C.in pulled to 300', clip(slid, 'C').start === 300 && near(clip(slid, 'C').sourceIn, 3))
check('slide: B content + duration unchanged', near(clip(slid, 'B').sourceIn, 2) && clip(slid, 'B').duration === 120)

console.log(ok ? '\nTIMELINE-TRIMMODES OK' : '\nTIMELINE-TRIMMODES FAILED')
process.exit(ok ? 0 : 1)
