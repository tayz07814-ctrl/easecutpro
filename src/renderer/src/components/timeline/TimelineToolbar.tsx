// Timeline toolbar: the row of controls above the lanes, grouped into segmented
// clusters — Snapping · Add · Tools · History. Every button drives the engine
// directly (magnet/snap/wave are session settings, detach/track are undoable
// commands), so there's no separate state to keep in sync.

import { useEngine, useTimeline } from './TimelineContext'
import { useStore } from '../../store'
import * as C from '@shared/timeline/commands'
import type { ReactNode } from 'react'

const WAVE_SIZES = [0.3, 0.6, 1.0]

// Flat, stroke-based icons (no emoji) so the toolbar matches the rest of the UI.
function Svg({ children, size = 15 }: { children: ReactNode; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}
// Horseshoe magnet with coloured poles so it reads unmistakably as a magnet.
const IcMagnet = (): JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6 8v3a6 6 0 0 0 12 0V8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6 4v4" stroke="#E5675C" strokeWidth={3} strokeLinecap="round" />
    <path d="M18 4v4" stroke="#5E8FE5" strokeWidth={3} strokeLinecap="round" />
  </svg>
)
const IcSnap = (): JSX.Element => <Svg><line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2.5 2.5" /><rect x="3" y="9" width="5.5" height="6" rx="1.2" /><rect x="15.5" y="9" width="5.5" height="6" rx="1.2" /></Svg>
const IcPlus = (): JSX.Element => <Svg><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Svg>
const IcImport = (): JSX.Element => <Svg><path d="M12 3v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></Svg>
const IcWave = (): JSX.Element => <Svg><line x1="4" y1="10" x2="4" y2="14" /><line x1="8" y1="7" x2="8" y2="17" /><line x1="12" y1="4" x2="12" y2="20" /><line x1="16" y1="8" x2="16" y2="16" /><line x1="20" y1="11" x2="20" y2="13" /></Svg>
const IcScissors = (): JSX.Element => <Svg><circle cx="6" cy="6" r="2.6" /><circle cx="6" cy="18" r="2.6" /><line x1="20" y1="4" x2="8.5" y2="15.5" /><line x1="14.5" y1="14.5" x2="20" y2="20" /><line x1="8.5" y1="8.5" x2="12" y2="12" /></Svg>
const IcUndo = (): JSX.Element => <Svg><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Svg>
const IcRedo = (): JSX.Element => <Svg><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></Svg>

export function TimelineToolbar(): JSX.Element {
  const engine = useEngine()
  const { session, interaction } = useTimeline()
  const importMedia = useStore((s) => s.importMedia)
  const { magnet, snapping, waveformSize } = session.settings
  const selected = interaction.selection

  const cycleWave = (): void => {
    const i = WAVE_SIZES.findIndex((s) => Math.abs(s - waveformSize) < 0.01)
    engine.updateSettings({ waveformSize: WAVE_SIZES[(i + 1) % WAVE_SIZES.length] })
  }
  const detach = (): void => {
    for (const id of selected) engine.dispatch(C.detachAudio(id))
  }

  return (
    <div className="ec-tl-toolbar">
      {/* Snapping */}
      <div className="ec-tl-grp">
        <button
          className={'ec-tl-seg' + (magnet ? ' on' : '')}
          onClick={() => engine.updateSettings({ magnet: !magnet })}
          title="Magnetic timeline: gaps close and neighbours ripple (M)"
        >
          <IcMagnet /> Magnet
        </button>
        <span className="ec-tl-ghair" />
        <button
          className={'ec-tl-seg' + (snapping ? ' on' : '')}
          onClick={() => engine.updateSettings({ snapping: !snapping })}
          title="Snap edges to clips, the playhead and markers while dragging"
        >
          <IcSnap /> Snap
        </button>
      </div>

      {/* Add */}
      <div className="ec-tl-grp">
        <button className="ec-tl-seg" onClick={() => engine.dispatch(C.addTrack('video'))} title="Add a video track">
          <IcPlus /> Track
        </button>
        <span className="ec-tl-ghair" />
        <button className="ec-tl-seg" onClick={importMedia} title="Import a video / audio file">
          <IcImport /> Import
        </button>
      </div>

      {/* Tools */}
      <div className="ec-tl-grp">
        <button className="ec-tl-seg" onClick={cycleWave} title="Waveform height on clips">
          <IcWave /> <span className="ec-tl-pct">{Math.round(waveformSize * 100)}%</span>
        </button>
        <span className="ec-tl-ghair" />
        <button
          className="ec-tl-seg"
          onClick={detach}
          disabled={selected.length === 0}
          title="Split the selected clip's audio onto its own track"
        >
          <IcScissors /> Detach
        </button>
      </div>

      <span className="ec-tl-tbspacer" />

      {/* History */}
      <div className="ec-tl-grp">
        <button className="ec-tl-seg icon" onClick={() => engine.undo()} disabled={!engine.canUndo()} title="Undo (Ctrl+Z)">
          <IcUndo />
        </button>
        <span className="ec-tl-ghair" />
        <button className="ec-tl-seg icon" onClick={() => engine.redo()} disabled={!engine.canRedo()} title="Redo (Ctrl+Shift+Z)">
          <IcRedo />
        </button>
      </div>
    </div>
  )
}
