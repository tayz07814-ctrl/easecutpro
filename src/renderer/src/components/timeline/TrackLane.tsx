// One track's lane: the horizontal strip that holds its clips.

import { ClipView } from './ClipView'
import { TRACK_COLOR } from './geometry'
import type { Track } from '@shared/timeline/types'
import type { Timebase } from '@shared/timeline/time'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

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
  return (
    <div
      className={`ec-tl-lane kind-${track.kind} ${track.hidden ? 'hidden' : ''} ${track.locked ? 'locked' : ''}`}
      style={{ width, height: track.height }}
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
          onClipPointerDown={onClipPointerDown}
          onHandlePointerDown={onHandlePointerDown}
          onClipContextMenu={onClipContextMenu}
        />
      ))}
    </div>
  )
}
