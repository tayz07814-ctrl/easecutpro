// Append a library clip to the END of the timeline through the SAME engine path
// drag-drop uses, so existing clips are preserved: video/image → the main (base)
// lane, audio → an audio lane (created if none exists). Shared by the desktop
// Editor (click-to-add media) and the mobile editor (Audio sheet), so both add
// clips identically. No-op until the engine + a target lane are ready.

import type { LibraryItem } from '@shared/types'
import { getSharedEngine } from './timelineEngine'
import { createClip, mainTrackId } from '@shared/timeline/model'
import { secondsToFrames } from '@shared/timeline/time'
import * as C from '@shared/timeline/commands'
import type { Command } from '@shared/timeline/commands'
import { uid } from '@shared/timeline/ids'

export function addMediaToTimeline(item: LibraryItem): void {
  const engine = getSharedEngine()
  if (!engine) return
  const doc = engine.document
  const tb = doc.timebase
  const isImage = item.kind === 'image'
  const isAudio = item.kind === 'audio'
  const durSec = isImage ? 4 : item.duration || 4
  const kind = isImage ? 'image' : isAudio ? 'audio' : 'video'
  const mainId = mainTrackId(doc)
  const cmds: Command[] = []
  let trackId = mainId ?? doc.tracks[0]?.id ?? ''
  if (isAudio) {
    const a = doc.tracks.find((t) => t.kind === 'audio')
    if (a) trackId = a.id
    else {
      trackId = uid('track')
      cmds.push(C.addTrack('audio', { id: trackId }))
    }
  }
  if (!trackId) return
  const lane = doc.tracks.find((t) => t.id === trackId)
  const endFrame = lane ? lane.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) : 0
  const clip = createClip({
    kind,
    trackId,
    start: endFrame,
    duration: secondsToFrames(durSec, tb),
    sourcePath: item.path,
    sourceIn: 0,
    sourceOut: durSec,
    sourceDuration: isImage ? 3600 : item.duration || durSec,
    srcW: item.width,
    srcH: item.height,
    srcFps: item.fps,
    name: item.name,
    hasAudio: item.hasAudio
  })
  cmds.push(trackId === mainId ? C.insertToMain(clip, endFrame) : C.addClip(clip))
  engine.batch('Add clip', cmds)
  engine.select([clip.id])
}
