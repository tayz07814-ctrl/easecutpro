// A track's sticky-left header: kind badge, name, and lock/mute/hide toggles.
// Toggles dispatch real commands — the header renders state and nothing else.

import { useEngine } from './TimelineContext'
import * as C from '@shared/timeline/commands'
import { TRACK_COLOR, laneHeight } from './geometry'
import type { Track } from '@shared/timeline/types'
import type { MouseEvent as ReactMouseEvent } from 'react'

const KIND_ICON: Record<Track['kind'], string> = {
  video: '🎞',
  audio: '🔊',
  text: 'T',
  overlay: '▣',
  subtitle: 'CC',
  effect: '✦',
  adjustment: '◐'
}

type Flags = Partial<Pick<Track, 'locked' | 'muted' | 'hidden' | 'collapsed' | 'solo'>>

export function TrackHeader({
  track,
  onHeaderContextMenu
}: {
  track: Track
  onHeaderContextMenu: (trackId: string, e: ReactMouseEvent) => void
}): JSX.Element {
  const engine = useEngine()
  const setFlags = (patch: Flags): void => engine.dispatch(C.setTrackFlags(track.id, patch))

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
      className="ec-tl-header"
      style={{ height: laneHeight(track) }}
      onContextMenu={(e) => onHeaderContextMenu(track.id, e)}
    >
      <span className="ec-tl-kind" style={{ background: TRACK_COLOR[track.kind] }}>
        {KIND_ICON[track.kind]}
      </span>
      <span className="ec-tl-tname" title={track.name}>
        {track.name}
      </span>
      {track.isMain && (
        <span className="ec-tl-main-badge" title="Main track — always gapless, receives imports">
          Main
        </span>
      )}
      <span className="ec-tl-hbtns">
        <button
          className={`ec-ic ${track.locked ? 'on' : ''}`}
          title={track.locked ? 'Unlock' : 'Lock'}
          onClick={() => setFlags({ locked: !track.locked })}
        >
          {track.locked ? '🔒' : '🔓'}
        </button>
        {track.kind === 'audio' ? (
          <button
            className={`ec-ic ${track.muted ? 'on' : ''}`}
            title={track.muted ? 'Unmute' : 'Mute'}
            onClick={() => setFlags({ muted: !track.muted })}
          >
            {track.muted ? '🔇' : '🔊'}
          </button>
        ) : (
          <button
            className={`ec-ic ${track.hidden ? 'on' : ''}`}
            title={track.hidden ? 'Show' : 'Hide'}
            onClick={() => setFlags({ hidden: !track.hidden })}
          >
            {track.hidden ? '🙈' : '👁'}
          </button>
        )}
      </span>
      <div className="ec-tl-hresize" title="Drag to resize track height" onMouseDown={startHeightDrag} />
    </div>
  )
}
