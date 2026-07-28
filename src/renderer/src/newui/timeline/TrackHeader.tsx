// A track's sticky-left header — reskinned to the 0.01 mock: just a quiet lane
// label (Text / Video / Audio). Lock, hide, mute and rename move into the
// right-click header menu (openHeaderMenu in Timeline.tsx) so the lane column
// stays as clean as the design; the bottom-edge grip still resizes height.

import { useEngine } from './TimelineContext'
import * as C from '@shared/timeline/commands'
import { laneHeight } from './geometry'
import type { Track } from '@shared/timeline/types'
import type { MouseEvent as ReactMouseEvent } from 'react'

/** Design lane names: the main video track reads "Video"; overlay video tracks
 *  keep their own name so a stacked b-roll lane is still distinguishable. */
function laneLabel(track: Track): string {
  if (track.kind === 'audio') return 'Audio'
  if (track.kind === 'text' || track.kind === 'subtitle') return track.isMain ? 'Text' : track.name || 'Text'
  if (track.kind === 'video') return track.isMain ? 'Video' : track.name || 'Overlay'
  return track.name || track.kind
}

export function TrackHeader({
  track,
  onHeaderContextMenu
}: {
  track: Track
  onHeaderContextMenu: (trackId: string, e: ReactMouseEvent) => void
}): JSX.Element {
  const engine = useEngine()

  // Drag the bottom edge to change the track's top-down height. Live-applied every
  // frame (no history spam); one undo entry is committed on release.
  function startHeightDrag(e: ReactMouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const h0 = track.height
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    let h = h0
    const onMove = (ev: MouseEvent): void => {
      h = Math.max(28, Math.min(360, h0 + (ev.clientY - startY)))
      engine.applyLive(C.setTrackHeight(track.id, h))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
      engine.dispatch(C.setTrackHeight(track.id, h))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`ec-tl-header${track.hidden ? ' is-hidden' : ''}`}
      style={{ height: laneHeight(track) }}
      onContextMenu={(e) => onHeaderContextMenu(track.id, e)}
      title="Right-click for lock / hide / rename"
    >
      <span className="ec-tl-hlabel">{laneLabel(track)}</span>
      <div className="ec-tl-hresize" title="Drag to resize track height" onMouseDown={startHeightDrag} />
    </div>
  )
}
