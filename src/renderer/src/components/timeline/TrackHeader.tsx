// A track's sticky-left header: kind badge, name, and lock/mute/hide toggles.
// Toggles dispatch real commands — the header renders state and nothing else.

import { useEngine } from './TimelineContext'
import * as C from '@shared/timeline/commands'
import { TRACK_COLOR } from './geometry'
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

  return (
    <div
      className="ec-tl-header"
      style={{ height: track.height }}
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
    </div>
  )
}
