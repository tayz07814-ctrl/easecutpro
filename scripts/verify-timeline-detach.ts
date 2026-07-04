// Verify detach-audio: a linked audio clip appears on an audio lane below, the
// video goes muted/detached, a busy lane spawns a new one, and a free lane is
// reused. Run: npx tsx scripts/verify-timeline-detach.ts

import {
  createTimeline,
  createTrack,
  createClip,
  addTrackToDoc,
  addClipToDoc,
  detachAudioInDoc,
  findClip
} from '../src/shared/timeline/model'
import { FPS_30 } from '../src/shared/timeline/time'
import type { TimelineDocument, Track } from '../src/shared/timeline/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const audioTracks = (d: TimelineDocument): Track[] => d.tracks.filter((t) => t.kind === 'audio')

let d = createTimeline(FPS_30)
d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'V1' }))
d = addTrackToDoc(d, createTrack({ kind: 'video', order: 1, id: 'V2' }))
d = addClipToDoc(d, createClip({ id: 'A', kind: 'video', trackId: 'V1', start: 0, duration: 150, sourcePath: 'a.mp4', sourceIn: 0, sourceOut: 5, sourceDuration: 20 }))
d = addClipToDoc(d, createClip({ id: 'B', kind: 'video', trackId: 'V2', start: 0, duration: 150, sourcePath: 'b.mp4', sourceIn: 0, sourceOut: 5, sourceDuration: 20 }))
d = addClipToDoc(d, createClip({ id: 'IMG', kind: 'image', trackId: 'V2', start: 200, duration: 60, sourcePath: 'i.png' }))

check('video clip defaults hasAudio = true', findClip(d, 'A')!.clip.hasAudio === true)
check('image clip defaults hasAudio = false', findClip(d, 'IMG')!.clip.hasAudio === false)

// detach A: no audio lane yet -> one is created below
const d1 = detachAudioInDoc(d, 'A')
check('detach A created an audio lane', audioTracks(d1).length === 1)
const audA = audioTracks(d1)[0].clips[0]
check('audio clip mirrors source A [0,150]', !!audA && audA.kind === 'audio' && audA.start === 0 && audA.end === 150 && audA.sourcePath === 'a.mp4')
check('video A now detached + muted', findClip(d1, 'A')!.clip.audioDetached === true && findClip(d1, 'A')!.clip.muted === true)
check('A and its audio are linked both ways', findClip(d1, 'A')!.clip.linkedClipIds.includes(audA.id) && audA.linkedClipIds.includes('A'))

// detach B (same 0..150 span): lane 1 is busy there -> a SECOND lane is created
const d2 = detachAudioInDoc(d1, 'B')
check('busy lane -> second audio lane created', audioTracks(d2).length === 2)

// detach a non-overlapping clip: reuse the first free lane instead of creating one
let d3 = addClipToDoc(d2, createClip({ id: 'C', kind: 'video', trackId: 'V1', start: 200, duration: 90, sourcePath: 'c.mp4', sourceIn: 0, sourceOut: 3, sourceDuration: 20 }))
d3 = detachAudioInDoc(d3, 'C')
const lane1 = audioTracks(d3)[0]
check('free span reuses an existing lane (no 3rd lane)', audioTracks(d3).length === 2 && lane1.clips.length === 2)

// idempotent: detaching an already-detached clip is a no-op
check('re-detach is a no-op', detachAudioInDoc(d3, 'A') === d3)
check('detach on image (no audio) is a no-op', detachAudioInDoc(d3, 'IMG') === d3)

console.log(ok ? '\nTIMELINE-DETACH OK' : '\nTIMELINE-DETACH FAILED')
process.exit(ok ? 0 : 1)
