// Insert a media-library item into the AUTHORITATIVE timeline document at the
// playhead — the doc-native equivalent of the desktop drag-drop (Timeline.tsx
// onDrop), shared by the mobile Overlay tool and the media library buttons.
//
// The legacy path (store.addLibraryToOverlay writing project.tracks) is
// invisible to doc-native projects: once project.timeline exists the bridge
// never re-reads legacy tracks, so an "added" overlay simply never appeared.
// Everything here goes through the engine so it lands on the real timeline,
// undoable, and visible immediately.

import { getSharedEngine } from './timelineEngine'
import * as C from '@shared/timeline/commands'
import type { Command } from '@shared/timeline/commands'
import { createClip, mainTrackId } from '@shared/timeline/model'
import { secondsToFrames } from '@shared/timeline/time'
import type { LibraryItem } from '@shared/types'

/** Images get this default length on any lane (trim to taste afterwards). */
export const IMAGE_DEFAULT_SEC = 4

/**
 * Insert `item` at the current playhead. `target`:
 *  - 'main'    → ripple-insert into the main lane (images become 4 s clips);
 *  - 'overlay' → the first overlay lane, CREATED if none exists yet (mobile
 *                hides empty overlay lanes — they appear on first use).
 * Returns true when a clip was added.
 */
export function insertLibraryItemAtPlayhead(item: LibraryItem, target: 'main' | 'overlay'): boolean {
  const engine = getSharedEngine()
  if (!engine || !engine.document.tracks.length) return false
  const doc = engine.document
  const tb = doc.timebase
  const at = Math.max(0, engine.sessionState.playhead)

  const isImage = item.kind === 'image'
  const isAudio = item.kind === 'audio'
  const durSec = isImage ? IMAGE_DEFAULT_SEC : item.duration || IMAGE_DEFAULT_SEC
  const kind = isImage ? 'image' : isAudio ? 'audio' : 'video'
  const mainId = mainTrackId(doc)

  const cmds: Command[] = []
  let trackId: string
  if (target === 'main' && !isAudio) {
    if (!mainId) return false
    trackId = mainId
  } else if (isAudio) {
    const a = doc.tracks.find((t) => t.kind === 'audio')
    trackId = a?.id ?? `track-ov-${Date.now().toString(36)}`
    if (!a) cmds.push(C.addTrack('audio', { id: trackId, name: 'Audio' }))
  } else {
    const ov = doc.tracks.find((t) => t.kind === 'video' && !t.isMain)
    if (ov) {
      trackId = ov.id
    } else {
      trackId = `track-ov-${Date.now().toString(36)}`
      const minOrder = Math.min(...doc.tracks.map((t) => t.order))
      cmds.push(C.addTrack('video', { id: trackId, name: 'Overlay 1', order: minOrder - 1 }))
    }
  }

  const clip = createClip({
    kind,
    trackId,
    start: at,
    duration: secondsToFrames(durSec, tb),
    sourcePath: item.path,
    sourceIn: 0,
    sourceOut: durSec,
    sourceDuration: isImage ? 3600 : item.duration || durSec,
    srcW: item.width,
    srcH: item.height,
    srcFps: item.fps,
    name: item.name,
    hasAudio: item.hasAudio,
    // Overlays start picture-in-picture (half size) like CapCut; the Adjust
    // panel moves/scales from there. Main-lane clips stay full frame.
    metadata: target === 'overlay' && !isAudio ? { ovScale: 0.5 } : undefined
  })
  cmds.push(target === 'main' && trackId === mainId ? C.insertToMain(clip, at) : C.addClip(clip))
  engine.batch(target === 'overlay' ? 'Add overlay' : 'Insert to main', cmds)
  engine.select([clip.id])
  return true
}
