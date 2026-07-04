// Verify Stage 4 #1: cut-engine output routed into the authoritative document's
// main lane. removedRangesToMainFrames maps removed base/virtual SECONDS onto the
// current main-lane clips by source intersection; applyDeletionsToDocument then
// ripple-deletes them. Manual splits/drops must survive, already-cut footage must
// map to nothing (idempotent), and multi-base virtual time must resolve per clip.
// Run: npx tsx scripts/verify-timeline-cutroute.ts

import { removedRangesToMainFrames } from '../src/shared/timeline/bridge'
import {
  createTimeline,
  createTrack,
  createClip,
  addTrackToDoc,
  addClipToDoc,
  applyDeletionsToDocument,
  splitClipInDoc,
  findTrack,
  mainTrackId
} from '../src/shared/timeline/model'
import { FPS_30, secondsToFrames } from '../src/shared/timeline/time'
import { computeKeepRanges, subtractRanges } from '../src/shared/edit'
import type { Project } from '../src/shared/types'
import type { TimelineDocument } from '../src/shared/timeline/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps
const tb = FPS_30
const mainClips = (d: TimelineDocument): TimelineDocument['tracks'][number]['clips'] => {
  const id = mainTrackId(d)
  return (id ? findTrack(d, id)?.clips : undefined) ?? []
}

// A route helper mirroring TimelinePanel's effect: full removed set -> frames -> apply.
function route(doc: TimelineDocument, project: Project): TimelineDocument {
  const dur = project.media?.duration ?? 0
  const removed = subtractRanges([{ start: 0, end: dur }], computeKeepRanges(project))
  const frames = removedRangesToMainFrames(doc, project, removed)
  const id = mainTrackId(doc)
  return id ? applyDeletionsToDocument(doc, id, frames, doc.timebase) : doc
}

// ---------------------------------------------------------------------------
// 1. Single media: one 10s base clip; delete the word at [3,4]s.
// ---------------------------------------------------------------------------
function singleDoc(): TimelineDocument {
  let d = createTimeline(tb)
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'MAIN', isMain: true }))
  d = addClipToDoc(
    d,
    createClip({ kind: 'video', trackId: 'MAIN', start: 0, duration: secondsToFrames(10, tb), sourcePath: 'v.mp4', sourceIn: 0, sourceOut: 10, sourceDuration: 10 })
  )
  return d
}
const words = (deleted: [number, number][]): Project['transcript'] => ({
  segments: [],
  words: [
    { id: 'w1', text: 'a', start: 3, end: 4 },
    { id: 'w2', text: 'b', start: 6, end: 7 }
  ].map((w) => ({ ...w, deleted: deleted.some(([s, e]) => near(w.start, s) && near(w.end, e)) }))
})

{
  const project = {
    name: 'P',
    media: { path: 'v.mp4', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true },
    transcript: words([[3, 4]]),
    silences: [],
    // no word-cut pad so the cut lands exactly on [3,4] for an exact assertion
    wordCutPad: 0
  } as unknown as Project

  const removed = subtractRanges([{ start: 0, end: 10 }], computeKeepRanges(project))
  check('1. removed range is [3,4]s', removed.length === 1 && near(removed[0].start, 3) && near(removed[0].end, 4))

  const doc0 = singleDoc()
  const frames = removedRangesToMainFrames(doc0, project, removed)
  check('1. removed -> one frame range [90,120]', frames.length === 1 && near(frames[0].start, 90) && near(frames[0].end, 120))

  const doc1 = route(doc0, project)
  const cl = mainClips(doc1)
  check('1. main lane split into two clips', cl.length === 2)
  check('1. gapless: clip0 [0..90], clip1 [90..270]', cl.length === 2 && cl[0].start === 0 && cl[0].end === 90 && cl[1].start === 90 && cl[1].end === 270)
  check('1. source coverage now [0,3] + [4,10]', cl.length === 2 && near(cl[0].sourceIn, 0) && near(cl[0].sourceOut, 3) && near(cl[1].sourceIn, 4) && near(cl[1].sourceOut, 10))
  check('1. edited duration = 9s (270f)', doc1.duration === 270)

  // idempotency: routing again with the SAME cut state removes nothing more.
  const doc2 = route(doc1, project)
  check('1. re-route is a no-op (idempotent)', mainClips(doc2).length === 2 && doc2.duration === 270)
}

// ---------------------------------------------------------------------------
// 2. Manual split survives a subsequent word cut.
// ---------------------------------------------------------------------------
{
  const project = {
    name: 'P',
    media: { path: 'v.mp4', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true },
    transcript: words([[3, 4]]),
    silences: [],
    wordCutPad: 0
  } as unknown as Project

  // user manually splits the base at 5s BEFORE cutting
  let d = singleDoc()
  const only = mainClips(d)[0]
  d = splitClipInDoc(d, only.id, secondsToFrames(5, tb), tb)
  check('2. manual split -> two clips at src boundary 5s', mainClips(d).length === 2 && near(mainClips(d)[1].sourceIn, 5))

  const removed = subtractRanges([{ start: 0, end: 10 }], computeKeepRanges(project))
  const routed = route(d, project)
  const cl = mainClips(routed)
  // expect: [0,3] , [4,5] (split boundary kept) , [5,10]  => 3 clips, 9s
  check('2. split boundary preserved after cut (3 clips)', cl.length === 3)
  check('2. coverage [0,3]+[4,5]+[5,10]', cl.length === 3 &&
    near(cl[0].sourceIn, 0) && near(cl[0].sourceOut, 3) &&
    near(cl[1].sourceIn, 4) && near(cl[1].sourceOut, 5) &&
    near(cl[2].sourceIn, 5) && near(cl[2].sourceOut, 10))
  check('2. still gapless, total 9s', cl[0].start === 0 && cl[1].start === cl[0].end && cl[2].start === cl[1].end && routed.duration === 270)
}

// ---------------------------------------------------------------------------
// 3. A dropped clip from ANOTHER source is never touched by the cut.
// ---------------------------------------------------------------------------
{
  const project = {
    name: 'P',
    media: { path: 'v.mp4', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true },
    transcript: words([[3, 4]]),
    silences: [],
    wordCutPad: 0
  } as unknown as Project

  let d = singleDoc()
  // drop a 2s b-roll from a DIFFERENT source onto the main lane at the end
  d = addClipToDoc(d, createClip({ kind: 'video', trackId: 'MAIN', start: secondsToFrames(10, tb), duration: secondsToFrames(2, tb), sourcePath: 'broll.mp4', sourceIn: 0, sourceOut: 2, sourceDuration: 2 }))
  const routed = route(d, project)
  const foreign = mainClips(routed).filter((c) => c.sourcePath === 'broll.mp4')
  check('3. foreign-source dropped clip survives intact', foreign.length === 1 && near(foreign[0].sourceIn, 0) && near(foreign[0].sourceOut, 2))
  check('3. only v.mp4 footage was cut', mainClips(routed).filter((c) => c.sourcePath === 'v.mp4').length === 2)
}

// ---------------------------------------------------------------------------
// 4. Multi-base (montage): virtual-time cut resolves to the right clip's source.
//    Two 5s clips of a.mp4: [0,5] then [10,15]. Virtual timeline is [0,10].
//    Delete virtual [6,7] -> belongs to clip 2 -> source [11,12].
// ---------------------------------------------------------------------------
{
  const montage = {
    name: 'M',
    baseSequence: [
      { id: 's1', sourcePath: 'a.mp4', name: 'a', sourceIn: 0, sourceOut: 5, sourceDuration: 20, hasAudio: true, srcW: 1920, srcH: 1080, fps: 30 },
      { id: 's2', sourcePath: 'a.mp4', name: 'a2', sourceIn: 10, sourceOut: 15, sourceDuration: 20, hasAudio: true, srcW: 1920, srcH: 1080, fps: 30 }
    ],
    texts: [],
    tracks: []
  } as unknown as Project

  let d = createTimeline(tb)
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'MAIN', isMain: true }))
  d = addClipToDoc(d, createClip({ kind: 'video', trackId: 'MAIN', start: 0, duration: secondsToFrames(5, tb), sourcePath: 'a.mp4', sourceIn: 0, sourceOut: 5, sourceDuration: 20 }))
  d = addClipToDoc(d, createClip({ kind: 'video', trackId: 'MAIN', start: secondsToFrames(5, tb), duration: secondsToFrames(5, tb), sourcePath: 'a.mp4', sourceIn: 10, sourceOut: 15, sourceDuration: 20 }))

  const removedVirtual = [{ start: 6, end: 7 }] // virtual seconds
  const frames = removedRangesToMainFrames(d, montage, removedVirtual)
  // virtual 6..7 -> clip2 (vStart 5), source 11..12 -> frames 180..210 on the lane
  check('4. virtual [6,7] -> frames [180,210]', frames.length === 1 && near(frames[0].start, 180) && near(frames[0].end, 210))

  const id = mainTrackId(d)!
  const routed = applyDeletionsToDocument(d, id, frames, tb)
  const cl = mainClips(routed)
  check('4. montage lane cut into 3 clips, total 9s', cl.length === 3 && routed.duration === 270)
  check('4. cut removed source [11,12] of clip 2', cl.some((c) => near(c.sourceIn, 10) && near(c.sourceOut, 11)) && cl.some((c) => near(c.sourceIn, 12) && near(c.sourceOut, 15)))
}

console.log(ok ? '\nTIMELINE-CUTROUTE OK' : '\nTIMELINE-CUTROUTE FAILED')
process.exit(ok ? 0 : 1)
