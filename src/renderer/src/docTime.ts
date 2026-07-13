// Edited-time ↔ source-time mapping for the transcript, shared by the legacy
// TranscriptPanel and the redesigned RetakeCleanerPanel (extracted here so the
// two components don't import each other). Behavior is identical to the original
// helpers that lived in TranscriptPanel.
//
// A single-source doc timeline runs the store playhead in EDITED time, but the
// transcript words stay in SOURCE time — so `playhead >= w.start` drifts by the
// cut amount and the highlighted word lags the audio. These map between the two
// through the main lane. Montage (multiple source files) keeps the words' own
// domain, so both return the value unchanged there (and in legacy mode).

import { mainTrackId } from '@shared/timeline/model'
import { secondsToFrames, framesToSeconds } from '@shared/timeline/time'
import type { TimelineDocument } from '@shared/timeline/types'

function docMainSingleSource(doc: TimelineDocument): TimelineDocument['tracks'][number] | null {
  const mainId = mainTrackId(doc)
  const main = mainId ? doc.tracks.find((t) => t.id === mainId) : undefined
  if (!main || !main.clips.length) return null
  return new Set(main.clips.map((c) => c.sourcePath)).size === 1 ? main : null
}

export function docEditedToSource(doc: TimelineDocument | undefined, editedSec: number): number {
  const main = doc ? docMainSingleSource(doc) : null
  if (!doc || !main) return editedSec
  const f = secondsToFrames(editedSec, doc.timebase)
  const clips = [...main.clips].sort((a, b) => a.start - b.start)
  const clip = clips.find((c) => f >= c.start && f < c.end) ?? clips[clips.length - 1]
  const span = clip.sourceOut - clip.sourceIn
  return clip.duration > 0 ? clip.sourceIn + ((f - clip.start) / clip.duration) * span : editedSec
}

export function docSourceToEdited(doc: TimelineDocument | undefined, srcSec: number): number {
  const main = doc ? docMainSingleSource(doc) : null
  if (!doc || !main) return srcSec
  const clips = [...main.clips].sort((a, b) => a.start - b.start)
  const clip = clips.find((c) => srcSec >= c.sourceIn && srcSec < c.sourceOut)
  if (!clip) {
    // the word was cut out: seek to the first kept clip that starts after it.
    const after = clips.find((c) => c.sourceIn >= srcSec) ?? clips[clips.length - 1]
    return framesToSeconds(after.start, doc.timebase)
  }
  const span = clip.sourceOut - clip.sourceIn
  const frac = span > 0 ? (srcSec - clip.sourceIn) / span : 0
  return framesToSeconds(clip.start + frac * clip.duration, doc.timebase)
}
