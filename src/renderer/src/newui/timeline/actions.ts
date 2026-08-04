// Timeline actions that more than one surface triggers.
//
// dropNeighbour lived inside TimelineToolbar, so the Q / E the toolbar prints on
// its own buttons had nothing behind them — the keyboard handler in Timeline.tsx
// could not reach it. Anything advertised as a shortcut belongs here, where the
// button and the key press call the same function.

import type { TimelineEngine } from '@shared/timeline/engine'
import { mainTrackId } from '@shared/timeline/model'

/** Ripple-delete the main-track clip just before (dir -1) or after (dir 1) the
 *  playhead. The ±1 frame slack makes a playhead sitting exactly on a cut count
 *  the clip it is touching, which is where you normally park it. */
export function dropNeighbour(engine: TimelineEngine, dir: -1 | 1): void {
  const doc = engine.document
  const main = doc.tracks.find((t) => t.id === mainTrackId(doc))
  if (!main) return
  const ph = engine.sessionState.playhead
  const clips = [...main.clips].sort((a, b) => a.start - b.start)
  const before = clips.filter((c) => c.end <= ph + 1)
  const target = dir < 0 ? before[before.length - 1] : clips.filter((c) => c.start >= ph - 1)[0]
  if (!target) return
  engine.select([target.id])
  engine.deleteSelection(true)
}
