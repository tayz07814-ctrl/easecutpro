// Verify the Project -> TimelineDocument bridge: single media becomes the main
// lane, overlays/text/music map to their lanes, times convert seconds->frames,
// and lane ordering is text/overlay/main/audio. Run: npx tsx scripts/verify-timeline-bridge.ts

import { projectToDocument, projectStructureKey, documentToProject } from '../src/shared/timeline/bridge'
import { secondsToFrames } from '../src/shared/timeline/time'
import {
  findTrack,
  createTimeline,
  createTrack,
  createClip,
  addTrackToDoc,
  addClipToDoc
} from '../src/shared/timeline/model'
import { FPS_30 } from '../src/shared/timeline/time'
import type { Project } from '../src/shared/types'
import type { TimelineDocument } from '../src/shared/timeline/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const trackByKind = (d: TimelineDocument, kind: string, notMain = false): ReturnType<typeof mainOf> =>
  d.tracks.find((t) => t.kind === kind && (!notMain || !t.isMain))
const mainOf = (d: TimelineDocument): TimelineDocument['tracks'][number] | undefined =>
  d.tracks.find((t) => t.isMain)

const project = {
  name: 'P',
  media: { path: 'v.mp4', duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true, hasVideo: true },
  texts: [
    { id: 't1', text: 'Hello', start: 1, end: 4, x: 0.5, y: 0.5, fontFamily: 'Arial', fontSize: 0.07, color: '#fff', align: 'center', bold: false, italic: false, strokeWidth: 0, strokeColor: '#000', bgEnabled: false, bgColor: '#000', bgRadius: 0, bgPadding: 0, bgOpacity: 1 }
  ],
  tracks: [
    { id: 'ov1', index: 1, name: 'Overlay', muted: false, hidden: false, clips: [{ id: 'c1', name: 'broll', sourcePath: 'b.mp4', sourceIn: 0, sourceOut: 2, start: 3, x: 0, y: 0, scale: 1, crop: { l: 0, t: 0, r: 0, b: 0 }, zoomStart: 1, zoomEnd: 1 }] }
  ],
  music: { path: 'm.mp3', name: 'Song', duration: 20, gain: 0.8, startAt: 0, loop: false }
} as unknown as Project

const doc = projectToDocument(project)
const tb = doc.timebase

const main = mainOf(doc)
check('main lane exists (isMain, video)', !!main && main.kind === 'video')
check('main has the base media clip', !!main && main.clips.length === 1 && main.clips[0].sourcePath === 'v.mp4')
check('media clip spans 10s -> 300f', !!main && main.clips[0].duration === secondsToFrames(10, tb))
check('media clip carries hasAudio', !!main && main.clips[0].hasAudio === true)

const text = trackByKind(doc, 'text')
check('text lane with the caption', !!text && text.clips[0].name === 'Hello')
check('text timed 1s->4s (30f start, 90f dur)', !!text && text.clips[0].start === secondsToFrames(1, tb) && text.clips[0].duration === secondsToFrames(3, tb))

const overlay = trackByKind(doc, 'video', true)
check('overlay lane (video, not main)', !!overlay && overlay.clips[0].sourcePath === 'b.mp4')
check('overlay clip at 3s, 2s long', !!overlay && overlay.clips[0].start === secondsToFrames(3, tb) && overlay.clips[0].duration === secondsToFrames(2, tb))

const music = trackByKind(doc, 'audio')
check('music audio lane', !!music && music.clips[0].sourcePath === 'm.mp3' && music.clips[0].hasAudio === true)

// ordering: text (top) < overlay < main < music (bottom)
check(
  'lane order text < overlay < main < music',
  !!text && !!overlay && !!main && !!music && text.order < overlay.order && overlay.order < main.order && main.order < music.order
)

// structure key stability: same structure -> same key; playhead-only change -> same key
const k1 = projectStructureKey(project)
const k2 = projectStructureKey({ ...project, playhead: 99 } as unknown as Project)
check('structure key ignores non-structural changes (playhead)', k1 === k2)

// montage base
const montage = { name: 'M', baseSequence: [
  { id: 's1', sourcePath: 'a.mp4', name: 'a', sourceIn: 0, sourceOut: 5, sourceDuration: 20, hasAudio: true, srcW: 1080, srcH: 1920, fps: 30 },
  { id: 's2', sourcePath: 'a.mp4', name: 'a2', sourceIn: 5, sourceOut: 9, sourceDuration: 20, hasAudio: true, srcW: 1080, srcH: 1920, fps: 30 }
], texts: [], tracks: [] } as unknown as Project
const md = projectToDocument(montage)
const mm = mainOf(md)
check('montage -> main lane gapless back-to-back', !!mm && mm.clips.length === 2 && mm.clips[0].start === 0 && mm.clips[1].start === secondsToFrames(5, md.timebase))

// --- reverse bridge: clip document -> Project (for preview/export) + round-trip ---
let rt = createTimeline(FPS_30)
rt = addTrackToDoc(rt, createTrack({ kind: 'video', order: 0, id: 'OV' }))
rt = addTrackToDoc(rt, createTrack({ kind: 'text', order: 1, id: 'TX' }))
rt = addTrackToDoc(rt, createTrack({ kind: 'video', order: 2, id: 'MAIN', isMain: true }))
rt = addClipToDoc(rt, createClip({ id: 'A', kind: 'video', trackId: 'MAIN', start: 0, duration: 150, sourcePath: 'a.mp4', sourceIn: 0, sourceOut: 5, sourceDuration: 20, srcW: 1080, srcH: 1920, srcFps: 30 }))
rt = addClipToDoc(rt, createClip({ id: 'B', kind: 'video', trackId: 'MAIN', start: 150, duration: 120, sourcePath: 'a.mp4', sourceIn: 8, sourceOut: 12, sourceDuration: 20, srcW: 1080, srcH: 1920, srcFps: 30 }))
rt = addClipToDoc(rt, createClip({ id: 'X', kind: 'video', trackId: 'OV', start: 300, duration: 60, sourcePath: 'b.mp4', sourceIn: 0, sourceOut: 2, sourceDuration: 10 }))
const baseP = { name: 'P', version: 1, transcript: undefined } as unknown as Project

const back = documentToProject(rt, baseP)
check('main lane -> baseSequence (2 already-trimmed segments)', (back.baseSequence?.length ?? 0) === 2)
check('baseSequence keeps source in/out', back.baseSequence![0].sourceIn === 0 && back.baseSequence![0].sourceOut === 5 && back.baseSequence![1].sourceIn === 8 && back.baseSequence![1].sourceOut === 12)
check('legacy cut state cleared (sequence is the final edit)', back.manualCuts.length === 0 && back.silences.length === 0 && back.baseSplits.length === 0)
check('overlay lane -> project.tracks', back.tracks.length === 1 && back.tracks[0].clips[0].sourcePath === 'b.mp4')
check('single media cleared for montage mode', back.media === undefined)
check('the clip document is stashed on project.timeline', back.timeline === rt)

// round-trip: Project -> document restores the main lane
const rtDoc = projectToDocument(back)
const main2 = rtDoc.tracks.find((t) => t.isMain)
check('round-trip: main lane restored to 2 gapless clips', !!main2 && main2.clips.length === 2 && main2.clips[0].start === 0 && main2.clips[1].start === 150)
check('round-trip: source slices preserved [0,5] [8,12]', !!main2 && main2.clips[0].sourceIn === 0 && main2.clips[0].sourceOut === 5 && main2.clips[1].sourceIn === 8 && main2.clips[1].sourceOut === 12)

console.log(ok ? '\nTIMELINE-BRIDGE OK' : '\nTIMELINE-BRIDGE FAILED')
process.exit(ok ? 0 : 1)
