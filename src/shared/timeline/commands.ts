// The command vocabulary. Every undoable edit is a Command: a label + a pure
// (document) -> document transform. The engine snapshots the resulting document
// for undo/redo, so commands stay small and side-effect free. Commands read the
// timebase straight off the document, so callers never pass it in.

import type { TimelineDocument, Track, Clip, TrackKind } from './types'
import {
  addTrackToDoc,
  removeTrackFromDoc,
  updateTrackInDoc,
  reorderTracksInDoc,
  addClipToDoc,
  removeClipFromDoc,
  moveClipInDoc,
  trimClipInInDoc,
  trimClipOutInDoc,
  splitClipInDoc,
  setClipSpeedInDoc,
  addMarkerToDoc,
  removeMarkerFromDoc,
  createTrack,
  defaultTrackName,
  magnetMoveInDoc,
  magnetTrimInInDoc,
  magnetTrimOutInDoc,
  detachAudioInDoc,
  moveClipSmartInDoc,
  addClipToMainInDoc,
  insertClipIntoMainInDoc,
  rollEditInDoc,
  slipClipInDoc,
  slideClipInDoc,
  applyDeletionsToDocument,
  compactTrackInDoc,
  setClipMetadataInDoc,
  setClipTransformStaticInDoc,
  setClipCropInDoc,
  setClipTextInDoc,
  setClipGainInDoc
} from './model'
import type { TextContent } from './types'
import { uid } from './ids'

export interface Command {
  readonly label: string
  apply(doc: TimelineDocument): TimelineDocument
}

function cmd(label: string, apply: (doc: TimelineDocument) => TimelineDocument): Command {
  return { label, apply }
}

// --- tracks ---

export function addTrack(
  kind: TrackKind,
  opts?: {
    name?: string
    order?: number
    id?: string
    height?: number
    main?: boolean
    autoCreated?: boolean
  }
): Command {
  return cmd(`Add ${kind} track`, (doc) => {
    const order = opts?.order ?? doc.tracks.reduce((m, t) => Math.max(m, t.order), -1) + 1
    const count = doc.tracks.filter((t) => t.kind === kind).length + 1
    const name = opts?.name ?? `${defaultTrackName(kind)} ${count}`
    return addTrackToDoc(
      doc,
      createTrack({
        kind,
        order,
        name,
        id: opts?.id,
        height: opts?.height,
        isMain: opts?.main,
        autoCreated: opts?.autoCreated
      })
    )
  })
}

/** Import a clip onto the main lane (appended gaplessly at its end). */
export function importToMain(clip: Clip): Command {
  return cmd('Import to main', (doc) => addClipToMainInDoc(doc, clip))
}

/** Insert a clip into the main lane at `atFrame`, rippling later clips right. */
export function insertToMain(clip: Clip, atFrame: number): Command {
  return cmd('Insert to main', (doc) => insertClipIntoMainInDoc(doc, clip, atFrame))
}

// --- professional trims ---

export function rollEdit(leftClipId: string, newBoundary: number): Command {
  return cmd('Roll', (doc) => rollEditInDoc(doc, leftClipId, newBoundary, doc.timebase))
}

export function slipClip(clipId: string, deltaFrames: number): Command {
  return cmd('Slip', (doc) => slipClipInDoc(doc, clipId, deltaFrames, doc.timebase))
}

export function slideClip(clipId: string, newStart: number): Command {
  return cmd('Slide', (doc) => slideClipInDoc(doc, clipId, newStart, doc.timebase))
}

/** Close all gaps in a lane (magnet turned on). */
export function compactTrack(trackId: string): Command {
  return cmd('Close gaps', (doc) => compactTrackInDoc(doc, trackId))
}

/** Apply cut-engine deletions (timeline frame ranges) to a lane as split + ripple. */
export function applyDeletions(
  trackId: string,
  ranges: Array<{ start: number; end: number }>
): Command {
  return cmd('Apply cuts', (doc) => applyDeletionsToDocument(doc, trackId, ranges, doc.timebase))
}

/** Move honouring each lane's rule: main lane ripples when magnet is on, else free. */
export function moveClipSmart(
  clipId: string,
  toTrackId: string,
  dropStart: number,
  magnet: boolean
): Command {
  return cmd('Move clip', (doc) => moveClipSmartInDoc(doc, clipId, toTrackId, dropStart, magnet))
}

export function removeTrack(trackId: string): Command {
  return cmd('Delete track', (doc) => removeTrackFromDoc(doc, trackId))
}

export function renameTrack(trackId: string, name: string): Command {
  return cmd('Rename track', (doc) => updateTrackInDoc(doc, trackId, { name }))
}

export function setTrackHeight(trackId: string, height: number): Command {
  return cmd('Resize track', (doc) =>
    updateTrackInDoc(doc, trackId, { height: Math.max(16, Math.round(height)) })
  )
}

export function setTrackFlags(
  trackId: string,
  flags: Partial<Pick<Track, 'locked' | 'muted' | 'hidden' | 'collapsed' | 'solo'>>
): Command {
  return cmd('Toggle track', (doc) => updateTrackInDoc(doc, trackId, flags))
}

export function reorderTracks(orderedTrackIds: string[]): Command {
  return cmd('Reorder tracks', (doc) => reorderTracksInDoc(doc, orderedTrackIds))
}

// --- clips ---

/** Add a fully-formed clip (build it with `createClip`). */
export function addClip(clip: Clip): Command {
  return cmd('Add clip', (doc) => addClipToDoc(doc, clip))
}

/** Lift delete: remove the clip, leave the gap. */
export function removeClip(clipId: string): Command {
  return cmd('Delete', (doc) => removeClipFromDoc(doc, clipId, false))
}

/** Ripple delete: remove the clip and close the gap on its track. */
export function rippleDelete(clipId: string): Command {
  return cmd('Ripple delete', (doc) => removeClipFromDoc(doc, clipId, true))
}

export function moveClip(clipId: string, toTrackId: string, toStart: number): Command {
  return cmd('Move clip', (doc) => moveClipInDoc(doc, clipId, toTrackId, toStart))
}

export function trimClipIn(clipId: string, newStart: number): Command {
  return cmd('Trim', (doc) => trimClipInInDoc(doc, clipId, newStart, doc.timebase))
}

export function trimClipOut(clipId: string, newEnd: number): Command {
  return cmd('Trim', (doc) => trimClipOutInDoc(doc, clipId, newEnd, doc.timebase))
}

export function splitClip(clipId: string, atFrame: number): Command {
  return cmd('Split', (doc) => splitClipInDoc(doc, clipId, atFrame, doc.timebase))
}

/** Razor every clip crossing `frame`, across all tracks (one undo step). */
export function razorAt(frame: number): Command {
  return cmd('Split at playhead', (doc) => {
    let d = doc
    for (const track of doc.tracks) {
      const hit = track.clips.find((c) => frame > c.start && frame < c.end)
      if (hit) d = splitClipInDoc(d, hit.id, frame, doc.timebase)
    }
    return d
  })
}

export function setClipSpeed(clipId: string, speed: number): Command {
  return cmd('Change speed', (doc) => setClipSpeedInDoc(doc, clipId, speed, doc.timebase))
}

/** Reposition/resize an overlay clip (legacy semantics: ovX/ovY top-left, ovScale
 *  width, ovZoomStart/ovZoomEnd Ken Burns), stored on clip metadata. */
export function setOverlayPlacement(
  clipId: string,
  patch: { ovX?: number; ovY?: number; ovScale?: number; ovZoomStart?: number; ovZoomEnd?: number }
): Command {
  return cmd('Position overlay', (doc) => setClipMetadataInDoc(doc, clipId, patch))
}

/** Crop an overlay/video clip (fractions removed from each edge). */
export function setOverlayCrop(
  clipId: string,
  patch: { left?: number; top?: number; right?: number; bottom?: number }
): Command {
  return cmd('Crop clip', (doc) => setClipCropInDoc(doc, clipId, patch))
}

/** Move a text (or transform-positioned) clip: static offset-from-centre x / y. */
export function setClipTransform(clipId: string, patch: { x?: number; y?: number; scale?: number }): Command {
  return cmd('Position', (doc) => setClipTransformStaticInDoc(doc, clipId, patch))
}

/** Edit a text clip's content (text, font, colour, background…). */
export function setClipText(clipId: string, patch: Partial<TextContent>): Command {
  return cmd('Edit text', (doc) => setClipTextInDoc(doc, clipId, patch))
}

/** Set a clip's audio gain / volume (0 = silent, 1 = original). */
export function setClipGain(clipId: string, gain: number): Command {
  return cmd('Set volume', (doc) => setClipGainInDoc(doc, clipId, gain))
}

/** Merge arbitrary keys into a clip's metadata (e.g. animation choice). */
export function setClipMetadata(clipId: string, patch: Record<string, string | number | boolean>): Command {
  return cmd('Set clip option', (doc) => setClipMetadataInDoc(doc, clipId, patch))
}

// --- markers ---

export function addMarker(frame: number, name = '', color = '#ff5252'): Command {
  return cmd('Add marker', (doc) =>
    addMarkerToDoc(doc, { id: uid('marker'), frame: Math.max(0, Math.round(frame)), name, color })
  )
}

export function removeMarker(markerId: string): Command {
  return cmd('Delete marker', (doc) => removeMarkerFromDoc(doc, markerId))
}

// --- magnetic variants (used when settings.magnet is on) ---

export function magnetMove(clipId: string, toTrackId: string, dropStart: number): Command {
  return cmd('Move clip', (doc) => magnetMoveInDoc(doc, clipId, toTrackId, dropStart))
}

export function magnetTrimIn(clipId: string, newStart: number): Command {
  return cmd('Trim', (doc) => magnetTrimInInDoc(doc, clipId, newStart, doc.timebase))
}

export function magnetTrimOut(clipId: string, newEnd: number): Command {
  return cmd('Trim', (doc) => magnetTrimOutInDoc(doc, clipId, newEnd, doc.timebase))
}

// --- audio ---

export function detachAudio(clipId: string): Command {
  return cmd('Detach audio', (doc) => detachAudioInDoc(doc, clipId))
}
