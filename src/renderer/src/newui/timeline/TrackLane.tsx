// One track's lane: the horizontal strip that holds its clips.

import { ClipView } from './ClipView'
import { TRACK_COLOR, laneHeight } from './geometry'
import { useStore } from '../../store'
import type { Track, Clip } from '@shared/timeline/types'
import type { Timebase } from '@shared/timeline/time'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

/** True when b picks up exactly where a left off in the SAME source at the same
 *  speed (a split, not a cut) — such joins play seamlessly and get no seam blend. */
function sourceContiguous(a: Clip, b: Clip): boolean {
  return (
    !!a.sourcePath &&
    a.sourcePath === b.sourcePath &&
    Math.abs(a.sourceOut - b.sourceIn) < 0.003 &&
    Math.abs((a.speed || 1) - (b.speed || 1)) < 1e-3
  )
}

export function TrackLane({
  track,
  width,
  zoom,
  tb,
  selection,
  waveSize,
  onClipPointerDown,
  onHandlePointerDown,
  onClipContextMenu
}: {
  track: Track
  width: number
  zoom: number
  tb: Timebase
  selection: string[]
  waveSize: number
  onClipPointerDown: (id: string, e: ReactPointerEvent) => void
  onHandlePointerDown: (id: string, edge: 'in' | 'out', e: ReactPointerEvent) => void
  onClipContextMenu: (id: string, e: ReactMouseEvent) => void
}): JSX.Element {
  const color = TRACK_COLOR[track.kind]
  const seamFade = useStore((s) => s.seamFade)

  // Cut seams on the MAIN lane: a clip that starts right where the previous one
  // ends on the timeline but does NOT continue the same source (a real cut) gets
  // the audio seam blend — mark it so the creator can SEE where blends apply.
  const seamIds = new Set<string>()
  if (track.isMain && seamFade.enabled && seamFade.ms > 0) {
    const ordered = [...track.clips].sort((a, b) => a.start - b.start)
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]
      const cur = ordered[i]
      const adjacent = Math.abs(prev.end - cur.start) <= 1 // frames
      if (adjacent && !sourceContiguous(prev, cur)) seamIds.add(cur.id)
    }
  }

  return (
    <div
      className={`ec-tl-lane kind-${track.kind} ${track.hidden ? 'hidden' : ''} ${track.locked ? 'locked' : ''}`}
      style={{ width, height: laneHeight(track) }}
    >
      {track.clips.map((c) => (
        <ClipView
          key={c.id}
          clip={c}
          zoom={zoom}
          tb={tb}
          color={color}
          selected={selection.includes(c.id)}
          waveSize={waveSize}
          seamMs={seamIds.has(c.id) ? seamFade.ms : 0}
          onClipPointerDown={onClipPointerDown}
          onHandlePointerDown={onHandlePointerDown}
          onClipContextMenu={onClipContextMenu}
        />
      ))}
    </div>
  )
}
