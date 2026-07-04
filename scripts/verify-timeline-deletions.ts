// Verify cut-engine deletions -> clip splits + ripple. A base clip with two
// removed timeline ranges becomes three gapless clips whose source segments are
// preserved. Run: npx tsx scripts/verify-timeline-deletions.ts

import {
  createTimeline,
  createTrack,
  createClip,
  addTrackToDoc,
  addClipToDoc,
  applyDeletionsToDocument,
  documentMainKeeps
} from '../src/shared/timeline/model'
import { FPS_30 } from '../src/shared/timeline/time'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps

// Base: one 10s clip (300f @30) with source 0..10.
let d = createTimeline(FPS_30)
d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'V', isMain: true }))
d = addClipToDoc(d, createClip({ id: 'A', kind: 'video', trackId: 'V', start: 0, duration: 300, sourcePath: 'a.mp4', sourceIn: 0, sourceOut: 10, sourceDuration: 20 }))

// Remove timeline [90,150] (src 3..5) and [210,240] (src 7..8).
const cut = applyDeletionsToDocument(d, 'V', [{ start: 90, end: 150 }, { start: 210, end: 240 }], FPS_30)
const clips = cut.tracks[0].clips.slice().sort((a, b) => a.start - b.start)

check('produced three gapless clips', clips.length === 3)
check('starts are gapless 0 / 90 / 150', clips[0].start === 0 && clips[1].start === 90 && clips[2].start === 150)
check('kept sources [0,3] [5,7] [8,10]',
  near(clips[0].sourceIn, 0) && near(clips[0].sourceOut, 3) &&
  near(clips[1].sourceIn, 5) && near(clips[1].sourceOut, 7) &&
  near(clips[2].sourceIn, 8) && near(clips[2].sourceOut, 10))
check('total kept duration = 210f (removed 90f of 300f)', cut.duration === 210)

// The same clip model drives preview AND export: one keep-segment list.
const segs = documentMainKeeps(cut, 'V')
check('export/preview see 3 segments off the clip model', segs.length === 3)
check('segments carry the exact kept source slices',
  segs[0].sourcePath === 'a.mp4' &&
  near(segs[0].in, 0) && near(segs[0].out, 3) &&
  near(segs[1].in, 5) && near(segs[1].out, 7) &&
  near(segs[2].in, 8) && near(segs[2].out, 10))

// A deletion covering a whole clip removes it entirely.
const gone = applyDeletionsToDocument(d, 'V', [{ start: 0, end: 300 }], FPS_30)
check('deleting the full span leaves the lane empty', gone.tracks[0].clips.length === 0)

// Out-of-range deletions are ignored.
const noop = applyDeletionsToDocument(d, 'V', [{ start: 400, end: 500 }], FPS_30)
check('deletion outside any clip is a no-op', noop.tracks[0].clips.length === 1 && noop.tracks[0].clips[0].duration === 300)

console.log(ok ? '\nTIMELINE-DELETIONS OK' : '\nTIMELINE-DELETIONS FAILED')
process.exit(ok ? 0 : 1)
