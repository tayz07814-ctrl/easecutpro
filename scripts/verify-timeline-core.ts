// Verify the timeline engine core (Layer 1): document model, command dispatch,
// undo/redo via snapshots, frame-exact split/trim, ripple delete, and the
// playhead-vs-undo separation. Pure/headless.
// Run: npx tsx scripts/verify-timeline-core.ts

import { TimelineEngine } from '../src/shared/timeline/engine'
import * as C from '../src/shared/timeline/commands'
import { createTimeline, createClip, findClip, findTrack } from '../src/shared/timeline/model'
import { FPS_30, framesToSeconds } from '../src/shared/timeline/time'
import type { Clip } from '../src/shared/timeline/types'

let ok = true
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) ok = false
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps

const eng = new TimelineEngine(createTimeline(FPS_30))
const doc = (): ReturnType<TimelineEngine['getSnapshot']>['doc'] => eng.getSnapshot().doc
const clip = (id: string): Clip | undefined => findClip(doc(), id)?.clip
const clipsOf = (tid: string): Clip[] => findTrack(doc(), tid)?.clips ?? []

// --- tracks + clips ---
eng.dispatch(C.addTrack('video', { id: 'V' }))
check('addTrack created a video track', !!findTrack(doc(), 'V'))

// A: source [0,5]s -> 150f at 30fps, at timeline 0. B: source [0,4]s -> 120f, back-to-back at 150.
eng.dispatch(
  C.addClip(
    createClip({ id: 'A', kind: 'video', trackId: 'V', start: 0, duration: 150, sourcePath: 'a.mp4', sourceIn: 0, sourceOut: 5, sourceDuration: 20 })
  )
)
eng.dispatch(
  C.addClip(
    createClip({ id: 'B', kind: 'video', trackId: 'V', start: 150, duration: 120, sourcePath: 'b.mp4', sourceIn: 0, sourceOut: 4, sourceDuration: 20 })
  )
)
check('two clips on track V', clipsOf('V').length === 2)
check('document duration = 270f', doc().duration === 270)
check('clips sorted by start', clipsOf('V')[0].id === 'A' && clipsOf('V')[1].id === 'B')

// --- negative-time clamp ---
eng.dispatch(C.moveClip('B', 'V', -100))
check('move to negative time clamps to 0', clip('B')!.start === 0)
eng.dispatch(C.moveClip('B', 'V', 150)) // put back

// --- ripple delete + undo/redo ---
const beforeRipple = doc()
eng.dispatch(C.rippleDelete('A'))
check('ripple delete removed A', !clip('A'))
check('ripple pulled B to 0', clip('B')!.start === 0)
check('duration after ripple = 120f', doc().duration === 120)
eng.undo()
check('undo restores exact prior document', doc() === beforeRipple)
check('undo brought A back at 0', clip('A')!.start === 0 && clip('B')!.start === 150)
eng.redo()
check('redo re-applies ripple', !clip('A') && clip('B')!.start === 0)
eng.undo() // back to A@0, B@150

// --- split (frame-exact, source partitioned) ---
eng.dispatch(C.splitClip('A', 75))
const parts = clipsOf('V').filter((c) => c.sourcePath === 'a.mp4').sort((a, b) => a.start - b.start)
check('split produced two A halves', parts.length === 2)
check('left half A [0,75], src [0,2.5]', parts[0].id === 'A' && parts[0].end === 75 && near(parts[0].sourceOut, 2.5))
check('right half [75,150], src [2.5,5]', parts[1].start === 75 && near(parts[1].sourceIn, 2.5) && near(parts[1].sourceOut, 5))
const rightHalfId = parts[1].id

// --- trims (media-aware, frame-exact) ---
eng.dispatch(C.trimClipOut('B', 210)) // 150..270 -> 150..210, sourceOut 4 -> 2
check('trimOut B end=210f', clip('B')!.end === 210)
check('trimOut moved sourceOut to 2s', near(clip('B')!.sourceOut, 2))
eng.dispatch(C.trimClipIn('B', 180)) // 150..210 -> 180..210, sourceIn 0 -> 1
check('trimIn B start=180f', clip('B')!.start === 180)
check('trimIn moved sourceIn to 1s', near(clip('B')!.sourceIn, 1))
check('B now 30f = 1s of source', clip('B')!.duration === 30 && near(framesToSeconds(clip('B')!.duration, FPS_30), 1))

// --- speed ---
eng.dispatch(C.setClipSpeed(rightHalfId, 2)) // 2.5s src @2x -> 1.25s -> 38f
check('speed set to 2x', clip(rightHalfId)!.speed === 2)
check('duration recomputed from speed (~38f)', clip(rightHalfId)!.duration === 38)

// --- playhead is NOT part of undo ---
eng.setPlayhead(123)
const beforeEdit = doc()
eng.dispatch(C.addMarker(60, 'm1'))
eng.undo() // undo the marker
check('playhead survives undo (session != document)', eng.getSnapshot().session.playhead === 123)
check('undo reverted the document only', doc() === beforeEdit)

// --- multiple track kinds + reorder ---
eng.dispatch(C.addTrack('text', { id: 'T' }))
eng.dispatch(C.addTrack('audio', { id: 'AU' }))
check('three tracks exist', doc().tracks.length === 3)
eng.dispatch(C.reorderTracks(['AU', 'V', 'T']))
check('reorder set track order by index', findTrack(doc(), 'AU')!.order === 0 && findTrack(doc(), 'T')!.order === 2)
check('tracks array kept sorted by order', doc().tracks[0].id === 'AU' && doc().tracks[2].id === 'T')

console.log(ok ? '\nTIMELINE-CORE OK' : '\nTIMELINE-CORE FAILED')
process.exit(ok ? 0 : 1)
