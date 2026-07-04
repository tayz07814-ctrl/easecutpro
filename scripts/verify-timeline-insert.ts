// Verify Stage 4 #3: dropping media onto the MAIN lane inserts at the drop point
// and ripples later clips right (CapCut insert), instead of appending to the end.
// Run: npx tsx scripts/verify-timeline-insert.ts

import { TimelineEngine } from '../src/shared/timeline/engine'
import * as C from '../src/shared/timeline/commands'
import { createTimeline, createTrack, createClip, addTrackToDoc, addClipToDoc, findTrack, mainTrackId } from '../src/shared/timeline/model'
import { FPS_30 } from '../src/shared/timeline/time'
import type { TimelineDocument, Clip } from '../src/shared/timeline/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const tb = FPS_30

function baseDoc(): TimelineDocument {
  let d = createTimeline(tb)
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'MAIN', isMain: true }))
  // three 100f clips laid gaplessly: A[0..100] B[100..200] Cc[200..300]
  d = addClipToDoc(d, createClip({ id: 'A', kind: 'video', trackId: 'MAIN', start: 0, duration: 100, sourcePath: 'a.mp4', sourceIn: 0, sourceOut: 3.33 }))
  d = addClipToDoc(d, createClip({ id: 'B', kind: 'video', trackId: 'MAIN', start: 100, duration: 100, sourcePath: 'b.mp4', sourceIn: 0, sourceOut: 3.33 }))
  d = addClipToDoc(d, createClip({ id: 'Cc', kind: 'video', trackId: 'MAIN', start: 200, duration: 100, sourcePath: 'c.mp4', sourceIn: 0, sourceOut: 3.33 }))
  return d
}
const mainClips = (d: TimelineDocument): Clip[] => (findTrack(d, mainTrackId(d)!)?.clips ?? []).slice().sort((a, b) => a.start - b.start)
const newClip = (id: string): Clip => createClip({ id, kind: 'video', trackId: 'MAIN', start: 0, duration: 50, sourcePath: 'new.mp4', sourceIn: 0, sourceOut: 1.66 })

// 1. Insert near the boundary between A and B (drop at frame ~95 -> boundary 100).
{
  const eng = new TimelineEngine(baseDoc())
  eng.dispatch(C.insertToMain(newClip('N'), 95))
  const cl = mainClips(eng.document)
  check('1. inserted between A and B (4 clips)', cl.length === 4)
  check('1. order A, N, B, Cc', cl.map((c) => c.id).join(',') === 'A,N,B,Cc')
  check('1. N sits at 100..150', cl[1].start === 100 && cl[1].end === 150)
  check('1. B and Cc rippled right by 50f', cl[2].id === 'B' && cl[2].start === 150 && cl[3].id === 'Cc' && cl[3].start === 250)
  check('1. still gapless, total 350f', cl[0].start === 0 && cl[1].start === cl[0].end && cl[2].start === cl[1].end && cl[3].start === cl[2].end && eng.document.duration === 350)
}

// 2. Drop at the very start -> N goes first, everything ripples.
{
  const eng = new TimelineEngine(baseDoc())
  eng.dispatch(C.insertToMain(newClip('N'), 5))
  const cl = mainClips(eng.document)
  check('2. N first', cl[0].id === 'N' && cl[0].start === 0)
  check('2. A/B/Cc pushed to 50/150/250', cl[1].id === 'A' && cl[1].start === 50 && cl[2].start === 150 && cl[3].start === 250)
}

// 3. Drop past the end -> appends.
{
  const eng = new TimelineEngine(baseDoc())
  eng.dispatch(C.insertToMain(newClip('N'), 999))
  const cl = mainClips(eng.document)
  check('3. N appended last at 300..350', cl[3].id === 'N' && cl[3].start === 300 && cl[3].end === 350)
}

// 4. Insert into empty main -> lands at 0.
{
  let d = createTimeline(tb)
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'MAIN', isMain: true }))
  const eng = new TimelineEngine(d)
  eng.dispatch(C.insertToMain(newClip('N'), 120))
  const cl = mainClips(eng.document)
  check('4. empty lane -> clip at 0', cl.length === 1 && cl[0].start === 0)
}

// 5. It is ONE undoable command.
{
  const eng = new TimelineEngine(baseDoc())
  eng.dispatch(C.insertToMain(newClip('N'), 95))
  eng.undo()
  check('5. undo restores the original 3 clips', mainClips(eng.document).length === 3)
}

console.log(ok ? '\nTIMELINE-INSERT OK' : '\nTIMELINE-INSERT FAILED')
process.exit(ok ? 0 : 1)
