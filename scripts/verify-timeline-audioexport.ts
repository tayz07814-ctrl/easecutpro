// Verify Stage 4 #2: document audio lanes are folded into the export shape.
// documentToProject must (a) mute a detached/muted base clip's own audio so it
// isn't mixed twice, and (b) emit every audio-lane clip (music / detached /
// dropped audio) as export-only `extraAudio` at its EDITED-second position, with
// the legacy single `music` slot cleared. Run: npx tsx scripts/verify-timeline-audioexport.ts

import { documentToProject } from '../src/shared/timeline/bridge'
import {
  createTimeline,
  createTrack,
  createClip,
  addTrackToDoc,
  addClipToDoc,
  detachAudioInDoc,
  updateTrackInDoc,
  findTrack,
  mainTrackId
} from '../src/shared/timeline/model'
import { FPS_30, secondsToFrames } from '../src/shared/timeline/time'
import type { Project } from '../src/shared/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const near = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) < eps
const tb = FPS_30
const baseP = { name: 'P', version: 1 } as unknown as Project

// ---------------------------------------------------------------------------
// 1. Detach audio: base clip goes silent, its audio becomes an extraAudio lane.
// ---------------------------------------------------------------------------
{
  let d = createTimeline(tb)
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'MAIN', isMain: true }))
  d = addClipToDoc(
    d,
    createClip({ id: 'A', kind: 'video', trackId: 'MAIN', start: 0, duration: secondsToFrames(6, tb), sourcePath: 'v.mp4', sourceIn: 0, sourceOut: 6, sourceDuration: 6, hasAudio: true })
  )
  d = detachAudioInDoc(d, 'A')

  const proj = documentToProject(d, baseP)
  check('1. base clip audio muted after detach', proj.baseSequence?.[0].hasAudio === false)
  check('1. one extraAudio lane emitted', (proj.extraAudio?.length ?? 0) === 1)
  const ea = proj.extraAudio![0]
  check('1. extraAudio points at the base source', ea.path === 'v.mp4')
  check('1. extraAudio carries source in/out [0,6]', near(ea.in, 0) && near(ea.out, 6))
  check('1. extraAudio at edited start 0s', near(ea.startAt, 0))
  check('1. legacy music slot cleared', proj.music === undefined)
}

// ---------------------------------------------------------------------------
// 2. Music lane + gain + edited position; detached audio at a later start.
// ---------------------------------------------------------------------------
{
  let d = createTimeline(tb)
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'MAIN', isMain: true }))
  d = addClipToDoc(d, createClip({ id: 'A', kind: 'video', trackId: 'MAIN', start: 0, duration: secondsToFrames(4, tb), sourcePath: 'v.mp4', sourceIn: 0, sourceOut: 4, hasAudio: true }))
  // music lane below, one clip starting at 2s on the edited timeline, gain 0.5
  d = addTrackToDoc(d, createTrack({ kind: 'audio', order: 1, id: 'MUS', name: 'Music' }))
  const mus = createClip({ kind: 'audio', trackId: 'MUS', start: secondsToFrames(2, tb), duration: secondsToFrames(10, tb), sourcePath: 'song.mp3', sourceIn: 0, sourceOut: 10, hasAudio: true })
  mus.gain = 0.5
  d = addClipToDoc(d, mus)

  const proj = documentToProject(d, baseP)
  check('2. base voice kept (not detached)', proj.baseSequence?.[0].hasAudio === true)
  check('2. music folded into extraAudio', (proj.extraAudio?.length ?? 0) === 1 && proj.extraAudio![0].path === 'song.mp3')
  check('2. music start at edited 2s', near(proj.extraAudio![0].startAt, 2))
  check('2. music gain preserved (0.5)', near(proj.extraAudio![0].gain, 0.5))
}

// ---------------------------------------------------------------------------
// 3. A muted (or hidden) audio track is excluded from the export mix.
// ---------------------------------------------------------------------------
{
  let d = createTimeline(tb)
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'MAIN', isMain: true }))
  d = addClipToDoc(d, createClip({ id: 'A', kind: 'video', trackId: 'MAIN', start: 0, duration: secondsToFrames(4, tb), sourcePath: 'v.mp4', sourceIn: 0, sourceOut: 4, hasAudio: true }))
  d = addTrackToDoc(d, createTrack({ kind: 'audio', order: 1, id: 'MUS', name: 'Music' }))
  d = addClipToDoc(d, createClip({ kind: 'audio', trackId: 'MUS', start: 0, duration: secondsToFrames(4, tb), sourcePath: 'song.mp3', sourceIn: 0, sourceOut: 4, hasAudio: true }))
  d = updateTrackInDoc(d, 'MUS', { muted: true })

  const proj = documentToProject(d, baseP)
  check('3. muted audio track dropped from extraAudio', (proj.extraAudio?.length ?? 0) === 0)
}

// ---------------------------------------------------------------------------
// 4. Ordinary project with base audio only -> no extraAudio (legacy graph path).
// ---------------------------------------------------------------------------
{
  let d = createTimeline(tb)
  d = addTrackToDoc(d, createTrack({ kind: 'video', order: 0, id: 'MAIN', isMain: true }))
  d = addClipToDoc(d, createClip({ id: 'A', kind: 'video', trackId: 'MAIN', start: 0, duration: secondsToFrames(4, tb), sourcePath: 'v.mp4', sourceIn: 0, sourceOut: 4, hasAudio: true }))
  const proj = documentToProject(d, baseP)
  check('4. base-audio-only project has empty extraAudio', (proj.extraAudio?.length ?? 0) === 0)
  check('4. base audio kept', proj.baseSequence?.[0].hasAudio === true)
  // sanity: the detached video clip still carries its frames (only audio muted)
  check('4. main lane intact', !!findTrack(d, mainTrackId(d)!) && findTrack(d, mainTrackId(d)!)!.clips.length === 1)
}

console.log(ok ? '\nTIMELINE-AUDIOEXPORT OK' : '\nTIMELINE-AUDIOEXPORT FAILED')
process.exit(ok ? 0 : 1)
