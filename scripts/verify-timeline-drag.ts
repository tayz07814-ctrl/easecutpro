// Verify Layer 2 interaction logic: snapping, free vs magnetic move (both axes),
// ripple trim, and the engine drag flow (begin/update/end -> one undoable command).
// Run: npx tsx scripts/verify-timeline-drag.ts

import { TimelineEngine } from '../src/shared/timeline/engine'
import {
  createTimeline,
  createTrack,
  createClip,
  addTrackToDoc,
  addClipToDoc,
  moveClipInDoc,
  magnetMoveInDoc,
  magnetTrimOutInDoc,
  findClip,
  findTrack
} from '../src/shared/timeline/model'
import { collectSnapPoints, snapEdges } from '../src/shared/timeline/snap'
import { FPS_30 } from '../src/shared/timeline/time'
import type { TimelineDocument } from '../src/shared/timeline/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps
const startOf = (d: TimelineDocument, id: string): number => findClip(d, id)!.clip.start
const trackOf = (d: TimelineDocument, id: string): string => findClip(d, id)!.clip.trackId

function base(): TimelineDocument {
  let d = createTimeline(FPS_30)
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'V' }))
  d = addClipToDoc(d, createClip({ id: 'A', kind: 'video', trackId: 'V', start: 0, duration: 150, sourcePath: 'a', sourceIn: 0, sourceOut: 5, sourceDuration: 20 }))
  d = addClipToDoc(d, createClip({ id: 'B', kind: 'video', trackId: 'V', start: 150, duration: 120, sourcePath: 'b', sourceIn: 0, sourceOut: 4, sourceDuration: 20 }))
  d = addClipToDoc(d, createClip({ id: 'C', kind: 'video', trackId: 'V', start: 270, duration: 120, sourcePath: 'c', sourceIn: 0, sourceOut: 4, sourceDuration: 20 }))
  return d
}

// --- snapping ---
const pts = collectSnapPoints(base(), new Set(['A']), 999)
check('snap points include neighbour edges + playhead + 0', pts.includes(390) && pts.includes(999) && pts.includes(0))
check('snapEdges snaps within threshold', JSON.stringify(snapEdges([148], [150], 5)) === JSON.stringify({ delta: 2, line: 150 }))
check('snapEdges returns null beyond threshold', snapEdges([100], [150], 5) === null)

// --- free move (magnet OFF): both axes, gaps stay ---
let f = addTrackToDoc(base(), createTrack({ kind: 'video', order: 1, id: 'V2' }))
f = moveClipInDoc(f, 'B', 'V2', 300)
check('free move: B changed track (up/down)', trackOf(f, 'B') === 'V2')
check('free move: B moved to 300 (left/right)', startOf(f, 'B') === 300)
check('free move: origin keeps its gap (no ripple)', startOf(f, 'A') === 0 && startOf(f, 'C') === 270)

// --- magnet move: same-track reorder, gapless ---
const m1 = magnetMoveInDoc(base(), 'C', 'V', 0)
check('magnet reorder: C to front @0', startOf(m1, 'C') === 0)
check('magnet reorder: A/B ripple to stay gapless', startOf(m1, 'A') === 120 && startOf(m1, 'B') === 270)

// --- magnet move: cross-track insert + origin closes gap ---
let x = base()
x = addTrackToDoc(x, createTrack({ kind: 'video', order: 1, id: 'V2' }))
x = addClipToDoc(x, createClip({ id: 'X', kind: 'video', trackId: 'V2', start: 0, duration: 90, sourcePath: 'x', sourceIn: 0, sourceOut: 3, sourceDuration: 20 }))
x = addClipToDoc(x, createClip({ id: 'Y', kind: 'video', trackId: 'V2', start: 90, duration: 90, sourcePath: 'y', sourceIn: 0, sourceOut: 3, sourceDuration: 20 }))
const m2 = magnetMoveInDoc(x, 'B', 'V2', 100)
check('magnet cross: origin closes gap (A,C butt)', startOf(m2, 'A') === 0 && startOf(m2, 'C') === 150)
check('magnet cross: B inserted between X and Y @90', trackOf(m2, 'B') === 'V2' && startOf(m2, 'B') === 90)
check('magnet cross: Y pushed right to 210', startOf(m2, 'Y') === 210)

// --- magnet ripple trim ---
const t = magnetTrimOutInDoc(base(), 'A', 90, FPS_30)
check('ripple trim: A shortened to 90f', findClip(t, 'A')!.clip.end === 90)
check('ripple trim: A sourceOut -> 3s', near(findClip(t, 'A')!.clip.sourceOut, 3))
check('ripple trim: B & C ripple left', startOf(t, 'B') === 90 && startOf(t, 'C') === 210)

// --- engine drag flow: free move commits ONE undoable step ---
const e1 = new TimelineEngine(base())
e1.updateSettings({ magnet: false, snapping: false })
e1.beginDrag('move', 'A', 0) // grab at A.start
e1.updateDrag(200, { trackId: 'V' })
check('drag preview follows pointer (uncommitted)', e1.getSnapshot().interaction.drag!.preview !== e1.document)
check('drag does not touch history until drop', !e1.canUndo())
e1.endDrag()
// Clips never stack on a lane: 200 would overlap B (150-270), and A (150f)
// doesn't fit in the B->C gap — the nearest free spot is after C (390).
check('drop committed the move (clamped off B — clips never stack)', startOf(e1.document, 'A') === 390 && e1.getSnapshot().interaction.drag === null)
check('drop is one undo step', e1.canUndo())
e1.undo()
check('undo restores A to 0', startOf(e1.document, 'A') === 0)

// --- engine drag flow: MAIN track always ripples (gapless), independent of settings ---
let mainDoc = createTimeline(FPS_30)
mainDoc = addTrackToDoc(mainDoc, createTrack({ kind: 'video', order: 0, id: 'M', isMain: true }))
mainDoc = addClipToDoc(mainDoc, createClip({ id: 'A', kind: 'video', trackId: 'M', start: 0, duration: 150, sourcePath: 'a', sourceIn: 0, sourceOut: 5, sourceDuration: 20 }))
mainDoc = addClipToDoc(mainDoc, createClip({ id: 'B', kind: 'video', trackId: 'M', start: 150, duration: 120, sourcePath: 'b', sourceIn: 0, sourceOut: 4, sourceDuration: 20 }))
mainDoc = addClipToDoc(mainDoc, createClip({ id: 'C', kind: 'video', trackId: 'M', start: 270, duration: 120, sourcePath: 'c', sourceIn: 0, sourceOut: 4, sourceDuration: 20 }))
const e2 = new TimelineEngine(mainDoc)
e2.updateSettings({ snapping: false })
e2.beginDrag('move', 'C', 270)
e2.updateDrag(0, { trackId: 'M' })
e2.endDrag()
check('main-track drop reorders C to front (gapless)', startOf(e2.document, 'C') === 0 && startOf(e2.document, 'A') === 120)

// --- selection ---
const e3 = new TimelineEngine(base())
e3.select(['A'])
check('select A', e3.isSelected('A') && !e3.isSelected('B'))
e3.toggleSelect('B')
check('additive toggle keeps A, adds B', e3.isSelected('A') && e3.isSelected('B'))
e3.toggleSelect('A')
check('toggle removes A', !e3.isSelected('A') && e3.isSelected('B'))
e3.clearSelection()
check('clear empties selection', e3.getSnapshot().interaction.selection.length === 0)

// --- group move: dragging one of a multi-selection moves them all, one undo ---
let gDoc = createTimeline(FPS_30)
gDoc = addTrackToDoc(gDoc, createTrack({ kind: 'video', order: 0, id: 'OV' })) // free lane
gDoc = addClipToDoc(gDoc, createClip({ id: 'P', kind: 'video', trackId: 'OV', start: 0, duration: 60, sourcePath: 'p', sourceIn: 0, sourceOut: 2, sourceDuration: 20 }))
gDoc = addClipToDoc(gDoc, createClip({ id: 'Q', kind: 'video', trackId: 'OV', start: 120, duration: 60, sourcePath: 'q', sourceIn: 0, sourceOut: 2, sourceDuration: 20 }))
const e4 = new TimelineEngine(gDoc)
e4.updateSettings({ snapping: false })
e4.select(['P', 'Q'])
e4.beginDrag('move', 'P', 0)
e4.updateDrag(100)
e4.endDrag()
check('group move: primary P shifted +100', startOf(e4.document, 'P') === 100)
check('group move: Q shifted by the same delta', startOf(e4.document, 'Q') === 220)
check('group move is one undo step', e4.canUndo())
e4.undo()
check('group move undo restores both', startOf(e4.document, 'P') === 0 && startOf(e4.document, 'Q') === 120)

console.log(ok ? '\nTIMELINE-DRAG OK' : '\nTIMELINE-DRAG FAILED')
process.exit(ok ? 0 : 1)
