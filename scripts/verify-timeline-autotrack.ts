// Verify Layer-A auto-tracks: empty auto-lanes are pruned, imports land on the
// main lane, moving a clip off an auto-lane removes it, and dragging past the
// top of the stack spawns a new lane on drop.
// Run: npx tsx scripts/verify-timeline-autotrack.ts

import { TimelineEngine } from '../src/shared/timeline/engine'
import {
  createTimeline,
  createTrack,
  createClip,
  addTrackToDoc,
  addClipToDoc,
  moveClipSmartInDoc,
  pruneEmptyAutoTracksInDoc,
  addClipToMainInDoc,
  findClip,
  findTrack
} from '../src/shared/timeline/model'
import { FPS_30 } from '../src/shared/timeline/time'
import type { TimelineDocument } from '../src/shared/timeline/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}

// --- prune empty auto-lanes ---
let d: TimelineDocument = createTimeline(FPS_30)
d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'M', isMain: true }))
d = addTrackToDoc(d, createTrack({ kind: 'text', order: 1, id: 'T' })) // default, not auto
d = addTrackToDoc(d, createTrack({ kind: 'overlay', order: 2, id: 'AO', autoCreated: true })) // auto empty
d = addTrackToDoc(d, createTrack({ kind: 'overlay', order: 3, id: 'AX', autoCreated: true }))
d = addClipToDoc(d, createClip({ id: 'x', kind: 'image', trackId: 'AX', start: 0, duration: 60, sourcePath: 'x.png' }))
const pruned = pruneEmptyAutoTracksInDoc(d)
check('prune removes an empty auto lane', !findTrack(pruned, 'AO'))
check('prune keeps a non-auto empty lane', !!findTrack(pruned, 'T'))
check('prune keeps an auto lane that has a clip', !!findTrack(pruned, 'AX'))
check('prune never removes main', !!findTrack(pruned, 'M'))

// --- import lands on main, gaplessly at its end ---
let m: TimelineDocument = createTimeline(FPS_30)
m = addTrackToDoc(m, createTrack({ kind: 'video', order: 0, id: 'M', isMain: true }))
m = addClipToDoc(m, createClip({ id: 'A', kind: 'video', trackId: 'M', start: 0, duration: 150, sourcePath: 'a', sourceIn: 0, sourceOut: 5, sourceDuration: 20 }))
const imported = addClipToMainInDoc(m, createClip({ id: 'B', kind: 'video', trackId: 'ignored', start: 999, duration: 120, sourcePath: 'b', sourceIn: 0, sourceOut: 4, sourceDuration: 20 }))
check('import appends to main at its end (150f)', findClip(imported, 'B')!.clip.trackId === 'M' && findClip(imported, 'B')!.clip.start === 150)

// --- moving the last clip off an auto lane prunes it ---
let g: TimelineDocument = createTimeline(FPS_30)
g = addTrackToDoc(g, createTrack({ kind: 'video', order: 0, id: 'M', isMain: true }))
g = addTrackToDoc(g, createTrack({ kind: 'overlay', order: 1, id: 'AO', autoCreated: true }))
g = addClipToDoc(g, createClip({ id: 'A', kind: 'video', trackId: 'M', start: 0, duration: 150, sourcePath: 'a', sourceIn: 0, sourceOut: 5, sourceDuration: 20 }))
g = addClipToDoc(g, createClip({ id: 'X', kind: 'image', trackId: 'AO', start: 0, duration: 90, sourcePath: 'x.png' }))
const moved = moveClipSmartInDoc(g, 'X', 'M', 300)
check('moving off an auto lane self-removes it', !findTrack(moved, 'AO'))
check('the clip landed on main', findClip(moved, 'X')!.clip.trackId === 'M')

// --- drag past the top spawns a new lane on drop ---
let z: TimelineDocument = createTimeline(FPS_30)
z = addTrackToDoc(z, createTrack({ kind: 'video', order: 0, id: 'M', isMain: true }))
z = addClipToDoc(z, createClip({ id: 'A', kind: 'video', trackId: 'M', start: 0, duration: 150, sourcePath: 'a', sourceIn: 0, sourceOut: 5, sourceDuration: 20 }))
const eng = new TimelineEngine(z)
eng.updateSettings({ snapping: false })
eng.beginDrag('move', 'A', 0)
eng.updateDrag(0, { zone: 'above' })
const drag = eng.getSnapshot().interaction.drag
const newId = drag?.newTrackId ?? ''
check('zone drag previews a new lane', !!newId && drag!.preview.tracks.length === 2)
eng.endDrag()
check('drop created the new lane', eng.document.tracks.length === 2 && findClip(eng.document, 'A')!.clip.trackId === newId)
const nt = findTrack(eng.document, newId)
check('new lane is auto-created and above main', nt?.autoCreated === true && nt!.order < findTrack(eng.document, 'M')!.order)
check('main kept (now empty, never pruned)', findTrack(eng.document, 'M')!.clips.length === 0)
check('the whole thing is one undo step', eng.canUndo())
eng.undo()
check('undo removes the new lane and restores A on main', eng.document.tracks.length === 1 && findClip(eng.document, 'A')!.clip.trackId === 'M')

console.log(ok ? '\nTIMELINE-AUTOTRACK OK' : '\nTIMELINE-AUTOTRACK FAILED')
process.exit(ok ? 0 : 1)
