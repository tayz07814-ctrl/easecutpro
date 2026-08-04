// Timeline toolbar — reskinned to the 0.01 redesign mock: a single flat run of
// text buttons (Magnet · Snap | Split · Delete · Crop · Drop before · Drop after)
// with a right-aligned mono readout (PLAYHEAD 0:07 · N cuts pending). Every button
// still drives the real engine, so this is a visual reskin, not a new timeline.
// Undo/redo, add-track, import and waveform size stay reachable (keyboard +
// right-click menus); the toolbar just leads with the cut-first controls the
// redesign centres on.

import { useEngine, useTimeline } from './TimelineContext'
import { dropNeighbour } from './actions'
import { useStore } from '../../store'
import { framesToSeconds } from '@shared/timeline/time'
import type { ReactNode } from 'react'

/** m:ss (no leading zero on minutes) — matches the design's "PLAYHEAD 0:07". */
function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Corner-bracket crop glyph (the four L's from the mock).
const IcCrop = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ marginRight: 5, verticalAlign: -1 }}>
    <path d="M1 1h4M1 1v4" stroke="currentColor" strokeWidth={1.5} />
    <path d="M11 1H7M11 1v4" stroke="currentColor" strokeWidth={1.5} />
    <path d="M1 11h4M1 11V7" stroke="currentColor" strokeWidth={1.5} />
    <path d="M11 11H7M11 11V7" stroke="currentColor" strokeWidth={1.5} />
  </svg>
)

const Kbd = ({ children }: { children: ReactNode }): JSX.Element => <kbd className="ec-tl-kbd">{children}</kbd>

export function TimelineToolbar(): JSX.Element {
  const engine = useEngine()
  const { session, interaction } = useTimeline()
  const setShowCropModal = useStore((s) => s.setShowCropModal)
  const { magnet, snapping } = session.settings
  const hasSel = interaction.selection.length > 0

  // Pending cuts = contiguous runs of struck transcript words (the same red
  // regions TrackLane draws). Recomputed reactively from the store selection.
  const selectedWordIds = useStore((s) => s.selectedWordIds)
  const words = useStore((s) => s.project.transcript?.words)
  let pending = 0
  if (words && selectedWordIds.size) {
    let inRun = false
    for (const w of words) {
      const struck = selectedWordIds.has(w.id)
      if (struck && !inRun) pending++
      inRun = struck
    }
  }

  return (
    <div className="ec-tl-toolbar">
      <button
        className={'ec-tl2' + (magnet ? ' on' : '')}
        onClick={() => engine.updateSettings({ magnet: !magnet })}
        title="Magnetic timeline: gaps close and neighbours ripple (M)"
      >
        Magnet
      </button>
      <button
        className={'ec-tl2' + (snapping ? ' on' : '')}
        onClick={() => engine.updateSettings({ snapping: !snapping })}
        title="Snap edges to clips, the playhead and markers while dragging"
      >
        Snap
      </button>

      <span className="ec-tl-sep" />

      <button className="ec-tl2" onClick={() => engine.splitAtPlayhead()} title="Split the clip under the playhead (S)">
        Split <Kbd>S</Kbd>
      </button>
      <button
        className={'ec-tl2' + (hasSel ? ' danger' : '')}
        disabled={!hasSel}
        onClick={() => engine.deleteSelection(true)}
        title="Ripple-delete the selected clip (Delete)"
      >
        Delete <Kbd>D</Kbd>
      </button>
      <button className="ec-tl2" onClick={() => setShowCropModal(true)} title="Crop &amp; reframe the video">
        <IcCrop />
        Crop
      </button>
      <button className="ec-tl2" onClick={() => dropNeighbour(engine, -1)} title="Drop the clip just before the playhead (Q)">
        Drop before <Kbd>Q</Kbd>
      </button>
      <button className="ec-tl2" onClick={() => dropNeighbour(engine, 1)} title="Drop the clip just after the playhead (E)">
        Drop after <Kbd>E</Kbd>
      </button>

      <span className="ec-tl-tbspacer" />

      <span className="ec-tl-ph">PLAYHEAD {mmss(framesToSeconds(session.playhead, engine.document.timebase))}</span>
      {pending > 0 && (
        <>
          <span className="ec-tl-ph">·</span>
          <span className="ec-tl-pending">
            {pending} cut{pending === 1 ? '' : 's'} pending
          </span>
        </>
      )}
    </div>
  )
}
