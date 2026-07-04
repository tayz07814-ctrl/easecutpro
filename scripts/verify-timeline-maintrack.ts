// Verify the CapCut main-track model: the main (isMain) lane is always gapless
// (reorder/insert/ripple), every other lane is free-position — decided per lane,
// not by a global switch. Run: npx tsx scripts/verify-timeline-maintrack.ts

import {
  createTimeline,
  createTrack,
  createClip,
  addTrackToDoc,
  addClipToDoc,
  moveClipSmartInDoc,
  compactTrackInDoc,
  mainTrackId,
  findClip,
  findTrack
} from '../src/shared/timeline/model'
import { TimelineEngine } from '../src/shared/timeline/engine'
import { FPS_30 } from '../src/shared/timeline/time'
import type { TimelineDocument } from '../src/shared/timeline/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const startOf = (d: TimelineDocument, id: string): number => findClip(d, id)!.clip.start
const trackOf = (d: TimelineDocument, id: string): string => findClip(d, id)!.clip.trackId
const clipCount = (d: TimelineDocument, tid: string): number => findTrack(d, tid)!.clips.length

function base(): TimelineDocument {
  let d = createTimeline(FPS_30)
  // main video lane M (gapless) + free overlay lane O
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'M', isMain: true }))
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 1, id: 'O' }))
  d = addClipToDoc(d, createClip({ id: 'A', kind: 'video', trackId: 'M', start: 0, duration: 150, sourcePath: 'a', sourceIn: 0, sourceOut: 5, sourceDuration: 20 }))
  d = addClipToDoc(d, createClip({ id: 'B', kind: 'video', trackId: 'M', start: 150, duration: 120, sourcePath: 'b', sourceIn: 0, sourceOut: 4, sourceDuration: 20 }))
  d = addClipToDoc(d, createClip({ id: 'X', kind: 'video', trackId: 'O', start: 100, duration: 90, sourcePath: 'x', sourceIn: 0, sourceOut: 3, sourceDuration: 20 }))
  return d
}

check('mainTrackId finds the main lane', mainTrackId(base()) === 'M')

// 1. main same-lane with magnet ON: reorder + gapless
const t1 = moveClipSmartInDoc(base(), 'A', 'M', 300, true)
check('magnet on: main reorder B->front, A ripples behind', startOf(t1, 'B') === 0 && startOf(t1, 'A') === 120)

// 1b. main same-lane with magnet OFF: free, gap left behind
const t1b = moveClipSmartInDoc(base(), 'A', 'M', 300, false)
check('magnet off: main moves freely, gap allowed', startOf(t1b, 'A') === 300 && startOf(t1b, 'B') === 150)

// 2. main -> free (magnet on): dropped freely on the overlay; main lane closes its gap
const t2 = moveClipSmartInDoc(base(), 'A', 'O', 500, true)
check('main->free: A lands free at 500 on O', trackOf(t2, 'A') === 'O' && startOf(t2, 'A') === 500)
check('main->free: main lane B ripples to 0', startOf(t2, 'B') === 0)

// 3. free -> main (magnet on): inserted gaplessly into main; the free origin keeps its gap (empties)
const t3 = moveClipSmartInDoc(base(), 'X', 'M', 160, true)
check('free->main: X inserted between A and B @150 (gapless)', trackOf(t3, 'X') === 'M' && startOf(t3, 'X') === 150)
check('free->main: B pushed to 240', startOf(t3, 'B') === 240)
check('free->main: origin overlay left empty (no ripple needed)', clipCount(t3, 'O') === 0)

// 4. free same-lane: free placement, no ripple
const t4 = moveClipSmartInDoc(base(), 'X', 'O', 400, true)
check('free move: X placed at 400, no ripple', startOf(t4, 'X') === 400 && clipCount(t4, 'O') === 1)

// --- magnet toggle re-closes gaps in the main lane ---
let gap = createTimeline(FPS_30)
gap = addTrackToDoc(gap, createTrack({ kind: 'video', order: 0, id: 'M', isMain: true }))
gap = addClipToDoc(gap, createClip({ id: 'A', kind: 'video', trackId: 'M', start: 0, duration: 150, sourcePath: 'a', sourceIn: 0, sourceOut: 5, sourceDuration: 20 }))
gap = addClipToDoc(gap, createClip({ id: 'B', kind: 'video', trackId: 'M', start: 400, duration: 120, sourcePath: 'b', sourceIn: 0, sourceOut: 4, sourceDuration: 20 }))
const compacted = compactTrackInDoc(gap, 'M')
check('compact closes the gap from 0 (A@0, B@150)', startOf(compacted, 'A') === 0 && startOf(compacted, 'B') === 150)

// via the engine: move a main clip freely (magnet off), then toggling magnet on re-attaches it
const et = new TimelineEngine(gap)
et.updateSettings({ magnet: false, snapping: false })
et.beginDrag('move', 'B', 400)
et.updateDrag(600, { trackId: 'M' })
et.endDrag()
check('magnet off: B moves freely to 600 (dead space allowed)', startOf(et.document, 'B') === 600)
et.updateSettings({ magnet: true })
check('magnet on: main compacts, B snaps back to attach @150', startOf(et.document, 'B') === 150)

console.log(ok ? '\nTIMELINE-MAINTRACK OK' : '\nTIMELINE-MAINTRACK FAILED')
process.exit(ok ? 0 : 1)
