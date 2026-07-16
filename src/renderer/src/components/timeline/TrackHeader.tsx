// A track's sticky-left header: kind badge, name, and lock/mute/hide toggles.
// Toggles dispatch real commands — the header renders state and nothing else.

import { useEngine } from './TimelineContext'
import * as C from '@shared/timeline/commands'
import { laneHeight } from './geometry'
import type { Track } from '@shared/timeline/types'
import type { ReactNode, MouseEvent as ReactMouseEvent } from 'react'

// Flat, stroke-based icons (no emoji) so the timeline matches the rest of the UI.
function Svg({ children, size = 14 }: { children: ReactNode; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

/** Monochrome track-type glyph (rendered in a neutral slate tile). */
function KindGlyph({ kind }: { kind: Track['kind'] }): JSX.Element {
  switch (kind) {
    case 'audio':
      return <Svg size={15}><line x1="4" y1="10" x2="4" y2="14" /><line x1="8" y1="7" x2="8" y2="17" /><line x1="12" y1="4" x2="12" y2="20" /><line x1="16" y1="8" x2="16" y2="16" /><line x1="20" y1="11" x2="20" y2="13" /></Svg>
    case 'text':
      return <Svg><line x1="5" y1="6" x2="19" y2="6" /><line x1="12" y1="6" x2="12" y2="19" /></Svg>
    case 'overlay':
      return <Svg><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></Svg>
    case 'subtitle':
      return <Svg><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M8 12h2M14 12h2" /></Svg>
    case 'effect':
      return <Svg><path d="M12 3l1.6 4.8L18.5 9.4 13.6 11 12 16l-1.6-5L5.5 9.4l4.9-1.6L12 3Z" /></Svg>
    case 'adjustment':
      return <Svg><line x1="4" y1="8" x2="20" y2="8" /><circle cx="9" cy="8" r="2.2" /><line x1="4" y1="16" x2="20" y2="16" /><circle cx="15" cy="16" r="2.2" /></Svg>
    default: // video
      return <Svg><rect x="2" y="6" width="13" height="12" rx="2" /><path d="m15 10 7-3v10l-7-3" /></Svg>
  }
}

const IcLock = ({ open }: { open: boolean }): JSX.Element => (
  <Svg><rect x="5" y="11" width="14" height="9" rx="2" />{open ? <path d="M8 11V7a4 4 0 0 1 7-2.6" /> : <path d="M8 11V7a4 4 0 0 1 8 0v4" />}</Svg>
)
const IcEye = ({ off }: { off: boolean }): JSX.Element =>
  off ? (
    <Svg><path d="M9.9 4.2A9 9 0 0 1 12 4c6.4 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9 9 0 0 0 3.4-.6" /><line x1="3" y1="3" x2="21" y2="21" /></Svg>
  ) : (
    <Svg><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Svg>
  )
const IcVol = ({ muted }: { muted: boolean }): JSX.Element => (
  <Svg><path d="M11 5 6 9H2v6h4l5 4V5Z" />{muted ? <><line x1="22" y1="9" x2="16" y2="15" /><line x1="16" y1="9" x2="22" y2="15" /></> : <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />}</Svg>
)

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
      className={`ec-tl-header${track.hidden ? ' is-hidden' : ''}`}
      style={{ height: laneHeight(track) }}
      onContextMenu={(e) => onHeaderContextMenu(track.id, e)}
    >
      <span className="ec-tl-kind">
        <KindGlyph kind={track.kind} />
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
          className={`ec-ic lock ${track.locked ? 'on' : ''}`}
          title={track.locked ? 'Unlock' : 'Lock'}
          onClick={() => setFlags({ locked: !track.locked })}
        >
          <IcLock open={!track.locked} />
        </button>
        {track.kind === 'audio' ? (
          <button
            className={`ec-ic mute ${track.muted ? 'on' : ''}`}
            title={track.muted ? 'Unmute' : 'Mute'}
            onClick={() => setFlags({ muted: !track.muted })}
          >
            <IcVol muted={track.muted} />
          </button>
        ) : (
          <button
            className={`ec-ic hide ${track.hidden ? 'on' : ''}`}
            title={track.hidden ? 'Show' : 'Hide'}
            onClick={() => setFlags({ hidden: !track.hidden })}
          >
            <IcEye off={track.hidden} />
          </button>
        )}
      </span>
      <div className="ec-tl-hresize" title="Drag to resize track height" onMouseDown={startHeightDrag} />
    </div>
  )
}
