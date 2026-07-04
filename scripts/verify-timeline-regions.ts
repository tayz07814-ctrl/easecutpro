// Verify the track-region rules via planDrop: video/image -> video lanes,
// text -> text lanes, audio -> audio lanes (below main only); incompatible drops
// keep the clip on its origin lane; drag-up spawns an upper lane, drag-down (audio
// only) spawns an audio lane. Run: npx tsx scripts/verify-timeline-regions.ts

import { createTimeline, createTrack, addTrackToDoc, planDrop } from '../src/shared/timeline/model'
import { FPS_30 } from '../src/shared/timeline/time'
import type { TimelineDocument } from '../src/shared/timeline/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}

// Layout: video V(0), text T(1), main M(2), audio A(3)
let d: TimelineDocument = createTimeline(FPS_30)
d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'V' }))
d = addTrackToDoc(d, createTrack({ kind: 'text', order: 1, id: 'T' }))
d = addTrackToDoc(d, createTrack({ kind: 'video', order: 2, id: 'M', isMain: true }))
d = addTrackToDoc(d, createTrack({ kind: 'audio', order: 3, id: 'A' }))

const P = (kind: string, opts: { trackId?: string; zone?: 'above' | 'below'; originTrackId: string }) =>
  planDrop(d, kind as never, opts)

// --- compatible existing lanes ---
check('video onto a video lane -> that lane', P('video', { trackId: 'V', originTrackId: 'V' }).trackId === 'V')
check('image onto a video lane -> that lane (images share video)', P('image', { trackId: 'V', originTrackId: 'V' }).trackId === 'V')
check('audio onto an audio lane -> that lane', P('audio', { trackId: 'A', originTrackId: 'A' }).trackId === 'A')
check('text onto a text lane -> that lane', P('text', { trackId: 'T', originTrackId: 'T' }).trackId === 'T')

// --- incompatible lanes keep the clip on its origin ---
check('video onto a text lane -> blocked (stays on origin)', P('video', { trackId: 'T', originTrackId: 'V' }).trackId === 'V')
check('video onto an audio lane -> blocked', P('video', { trackId: 'A', originTrackId: 'V' }).trackId === 'V')
check('audio onto a video lane -> blocked', P('audio', { trackId: 'V', originTrackId: 'A' }).trackId === 'A')
check('text onto a video lane -> blocked', P('text', { trackId: 'V', originTrackId: 'T' }).trackId === 'T')

// --- zones: spawn new lanes in the correct region ---
const upV = P('video', { zone: 'above', originTrackId: 'V' })
check('video dragged up -> new video lane at top', upV.type === 'new' && upV.kind === 'video' && upV.order === -1)
const upT = P('text', { zone: 'above', originTrackId: 'T' })
check('text dragged up -> new text lane at top', upT.type === 'new' && upT.kind === 'text')
const downA = P('audio', { zone: 'below', originTrackId: 'A' })
check('audio dragged down -> new audio lane at bottom', downA.type === 'new' && downA.kind === 'audio' && downA.order === 4)

// --- region boundaries: no crossing main ---
check('video dragged down (into audio region) -> blocked', P('video', { zone: 'below', originTrackId: 'V' }).type === 'existing')
check('audio dragged up (above main) -> blocked', P('audio', { zone: 'above', originTrackId: 'A' }).type === 'existing')

console.log(ok ? '\nTIMELINE-REGIONS OK' : '\nTIMELINE-REGIONS FAILED')
process.exit(ok ? 0 : 1)
