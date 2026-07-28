// App wrapper: the timeline is a live VIEW of the project.
//
//   forward   — projectToDocument builds the engine doc from the project,
//               Main lane = the CUT RESULT (computeKeepRanges), so FastCut/
//               ProCut/word-cuts show. Re-hydrated when the structure or cuts
//               change.
//   playhead  — the store playhead is SOURCE seconds; the timeline is EDITED
//               frames. We map with collapseTime/expandTime, both ways, guarded:
//               preview playback moves the slider; scrubbing the timeline seeks
//               the preview.
//   zoom      — store.pxPerSec drives the engine zoom.
//
// (Persisting clip drags/trims back into the project is the next step; today the
// timeline reflects the project + drives the playhead.)

import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../../store'
import { setSharedEngine } from '../../timelineEngine'
import { TimelineEngine } from '@shared/timeline/engine'
import { projectToDocument, projectStructureKey, removedRangesToMainFrames, normalizeDefaultLanes } from '@shared/timeline/bridge'
import { computeKeepRanges, collapseTime, expandTime, baseTimelineDuration, subtractRanges } from '@shared/edit'
import { secondsToFrames, framesToSeconds } from '@shared/timeline/time'
import { mainTrackId } from '@shared/timeline/model'
import * as Commands from '@shared/timeline/commands'
import type { Project } from '@shared/types'
import { TimelineProvider } from './TimelineContext'
import { MediaDataProvider } from './MediaData'
import { useMediaManager } from './useMediaManager'
import Timeline from './Timeline'
import MobileTimeline from './MobileTimeline'
// Reuse the ORIGINAL timeline.css (one shared stylesheet — no duplicate .ec-tl-*
// rules). New-UI redesign overrides live scoped under .ec-newui in newui.css, so
// main's timeline (not under .ec-newui) is unaffected.
import '../../components/timeline/timeline.css'

/** The removed (cut) ranges = the complement of the kept ranges within [0,dur]. */
function removedRanges(keeps: { start: number; end: number }[], dur: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let cursor = 0
  for (const k of keeps) {
    if (k.start > cursor) out.push({ start: cursor, end: k.start })
    cursor = Math.max(cursor, k.end)
  }
  if (cursor < dur) out.push({ start: cursor, end: dur })
  return out
}

export default function TimelinePanel({ mobile = false }: { mobile?: boolean }): JSX.Element {
  const project = useStore((s) => s.project)
  const projectRef = useRef(project)
  projectRef.current = project
  const media = useMediaManager()

  // The engine hydrates from the authoritative document when the project already
  // has one; otherwise it is built (once) from the legacy fields, and that build
  // becomes authoritative the moment the user makes an edit (lazy migration).
  const engine = useMemo(
    () => new TimelineEngine(normalizeDefaultLanes(project.timeline ?? projectToDocument(project))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const applying = useRef(false) // guards hydrate/rebuild + store->engine playhead from echoing back
  // Identity of the document the engine currently reflects — lets us tell our own
  // persisted writes (skip) apart from an externally-loaded document (re-hydrate).
  const lastDoc = useRef(engine.document)

  // Publish the engine so the preview/export (outside the timeline tree) read and
  // edit the same authoritative document.
  useEffect(() => {
    setSharedEngine(engine)
    return () => setSharedEngine(null)
  }, [engine])

  // Persist every ENGINE edit to project.timeline, making the document
  // authoritative. Fires only when the document identity changes (an undoable
  // edit / undo / redo); playhead, zoom and selection commits are ignored, and
  // programmatic rebuilds (guarded by `applying`) don't echo back.
  useEffect(() => {
    return engine.subscribe(() => {
      if (applying.current) return
      const d = engine.document
      if (d === lastDoc.current) return
      lastDoc.current = d
      useStore.getState().setTimelineDoc(d)
    })
  }, [engine])

  // Re-hydrate when an EXTERNAL document arrives (opening another project). Our
  // own persisted writes carry the identity we just stored, so they no-op here.
  useEffect(() => {
    const doc = projectRef.current.timeline
    if (!doc || doc === lastDoc.current) return
    applying.current = true
    engine.replaceDocument(normalizeDefaultLanes(doc))
    lastDoc.current = engine.document
    applying.current = false
  }, [engine, project.timeline])

  // cut geometry for the source<->edited playhead mapping; recomputed on cut change
  const sig = projectStructureKey(project)
  const cutInfo = useMemo(() => {
    const p = projectRef.current
    const dur = baseTimelineDuration(p) || p.media?.duration || 0
    const cuts = removedRanges(computeKeepRanges(p), dur)
    return { cuts, dur }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  const cutRef = useRef(cutInfo)
  cutRef.current = cutInfo

  // Is the doc-native player (DocPreview) the ACTIVE preview? VideoPreview mounts
  // it the instant the shared engine's MAIN lane has clips — true for ANY media
  // project, because projectToDocument lays the cut result out GAPLESSLY. When it
  // is active, the store playhead is EDITED (gapless) seconds and maps to the
  // engine 1:1. Gating this on project.timeline was the bug: executeCuts (Retake)
  // never sets project.timeline, so after cuts the timeline treated the playhead
  // as SOURCE and ran it through collapse/expand while DocPreview treated it as
  // EDITED — a click seeked to the wrong spot and play restarted from 0. Only the
  // pure legacy <video> preview (no doc main clips, hence no cuts) uses SOURCE
  // seconds and needs the collapse/expand mapping (a no-op there anyway).
  const docPlayheadActive = (): boolean => {
    const main = engine.document.tracks.find((tk) => tk.isMain)
    return !!main && main.clips.length > 0
  }

  // LEGACY view: rebuild the whole document from the legacy fields on structural /
  // cut changes, so imports / Fast Cut / Pro Cut / silences show — but ONLY until
  // the document becomes authoritative. Once `project.timeline` exists the document
  // owns the structure and is NEVER rebuilt from legacy (that was wiping manual
  // main-lane edits — splits, dropped clips).
  const lastSig = useRef(sig)
  useEffect(() => {
    if (projectRef.current.timeline) return
    if (sig === lastSig.current) return
    lastSig.current = sig
    applying.current = true
    engine.replaceDocument(projectToDocument(projectRef.current))
    lastDoc.current = engine.document
    applying.current = false
  }, [engine, sig])

  // DOCUMENT mode: route cut-engine output into the main lane. Once the document
  // is authoritative the legacy rebuild above is disabled (it wiped manual
  // splits/drops), so Fast/Pro/word/filler/silence cuts — which still write the
  // legacy transcript/silences — no longer show. Here, whenever the CUT signature
  // changes (those fields are part of `sig`; structural doc edits are NOT, they
  // live in project.timeline), we translate the newly-removed footage into main-
  // lane frame ranges and ripple-delete it as ONE undoable command. Source already
  // cut from the lane maps to nothing, so this only ever removes the NEW cuts and
  // manual splits/drops are preserved. (Restoring a cut word can't re-add footage
  // to the edited lane and is a known no-op here — the transcript still records it.)
  const lastCutSig = useRef(sig)
  useEffect(() => {
    if (!projectRef.current.timeline) {
      lastCutSig.current = sig
      return
    }
    if (sig === lastCutSig.current) return
    lastCutSig.current = sig
    const p = projectRef.current
    const dur = p.media?.duration ?? baseTimelineDuration(p)
    if (dur <= 0) return
    const mainId = mainTrackId(engine.document)
    if (!mainId) return
    // Pass the media waveform so cut edges snap to energy VALLEYS + swallow edge
    // blips — the same smoothing legacy preview/export get, so doc-mode Fast/Pro/
    // word/silence seams land on real air gaps instead of raw whisper timestamps.
    const waveform = useStore.getState().waveform
    const removed = subtractRanges([{ start: 0, end: dur }], computeKeepRanges(p, waveform))
    const frames = removedRangesToMainFrames(engine.document, p, removed)
    if (frames.length) engine.dispatch(Commands.applyDeletions(mainId, frames))
  }, [engine, sig])

  // store playhead -> engine (edited frames). In doc-preview mode the store
  // playhead IS edited seconds (the gapless main lane); in the legacy source-time
  // preview it is source seconds and collapses through the cut ranges.
  useEffect(() => {
    const editedS = docPlayheadActive() ? project.playhead : collapseTime(project.playhead, cutInfo.cuts)
    applying.current = true
    engine.setPlayhead(secondsToFrames(editedS, engine.document.timebase))
    applying.current = false
  }, [engine, project.playhead, cutInfo])

  // store zoom -> engine
  useEffect(() => {
    engine.setZoom(project.pxPerSec)
  }, [engine, project.pxPerSec])

  // engine playhead (user scrub) -> store (source secs), so the preview seeks
  useEffect(() => {
    let lastPh = engine.sessionState.playhead
    return engine.subscribe(() => {
      if (applying.current) return
      const ph = engine.sessionState.playhead
      if (ph === lastPh) return // a doc/selection change, not a scrub
      lastPh = ph
      const editedS = framesToSeconds(ph, engine.document.timebase)
      const srcS = docPlayheadActive() ? editedS : expandTime(editedS, cutRef.current.cuts, cutRef.current.dur)
      useStore.getState().setPlayhead(srcS)
    })
  }, [engine])

  return (
    <MediaDataProvider value={media}>
      <TimelineProvider engine={engine}>{mobile ? <MobileTimeline /> : <Timeline />}</TimelineProvider>
    </MediaDataProvider>
  )
}
