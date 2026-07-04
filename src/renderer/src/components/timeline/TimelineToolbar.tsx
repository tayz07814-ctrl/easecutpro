// Timeline toolbar: the row of controls above the lanes (Magnet, Snap, add
// track, import, waveform size, detach audio, undo/redo). Every button drives
// the engine directly — magnet/snap/wave are session settings, detach/track are
// undoable commands — so there is no separate state to keep in sync.

import { useEngine, useTimeline } from './TimelineContext'
import { useStore } from '../../store'
import * as C from '@shared/timeline/commands'

const WAVE_SIZES = [0.3, 0.6, 1.0]

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
      <button
        className={'ec-tl-tbtn' + (magnet ? ' on' : '')}
        onClick={() => engine.updateSettings({ magnet: !magnet })}
        title="Magnetic timeline: gaps close and neighbours ripple (M)"
      >
        🧲 Magnet
      </button>
      <button
        className={'ec-tl-tbtn' + (snapping ? ' on' : '')}
        onClick={() => engine.updateSettings({ snapping: !snapping })}
        title="Snap edges to clips, the playhead and markers while dragging"
      >
        ⊟ Snap
      </button>

      <span className="ec-tl-tbsep" />

      <button className="ec-tl-tbtn" onClick={() => engine.dispatch(C.addTrack('video'))} title="Add a video track">
        ＋ Track
      </button>
      <button className="ec-tl-tbtn" onClick={importMedia} title="Import a video / audio file">
        ⬇ Import
      </button>
      <button className="ec-tl-tbtn" onClick={cycleWave} title="Waveform height on clips">
        ◍ Wave {Math.round(waveformSize * 100)}%
      </button>
      <button
        className="ec-tl-tbtn"
        onClick={detach}
        disabled={selected.length === 0}
        title="Split the selected clip's audio onto its own track"
      >
        ✂ Detach audio
      </button>

      <span className="ec-tl-tbspacer" />

      <button className="ec-tl-tbtn" onClick={() => engine.undo()} disabled={!engine.canUndo()} title="Undo (Ctrl+Z)">
        ↶
      </button>
      <button className="ec-tl-tbtn" onClick={() => engine.redo()} disabled={!engine.canRedo()} title="Redo (Ctrl+Shift+Z)">
        ↷
      </button>
    </div>
  )
}
