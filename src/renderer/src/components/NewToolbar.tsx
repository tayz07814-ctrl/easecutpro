import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { IS_WEB } from '../platform'
import ProjectTitle from './ProjectTitle'

/**
 * Redesigned editor top bar (VITE_NEW_EASECUT_UI only). Minimal + premium:
 * Projects · editable name + autosave status · undo/redo · Import · overflow (…)
 * · prominent Export. Every control calls the SAME existing store action as the
 * legacy Toolbar — this is presentation only. Less-used actions (Open, Save,
 * Detect silence, Remove gaps, Zoom, Settings) live in the … menu. Magnet/Split
 * stay in the timeline toolbar (unchanged), so they aren't duplicated here.
 */
export default function NewToolbar(): JSX.Element {
  const s = useStore()
  const hasBase = !!s.project.media || ((s.project.baseSequence?.length ?? 0) > 0)
  const [menu, setMenu] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    function onDown(e: MouseEvent): void {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  const run = (fn: () => void): void => {
    fn()
    setMenu(false)
  }

  return (
    <div className="nt">
      <button className="nt-projects" onClick={s.goHome} title="Back to your projects">
        <span className="nt-chevron">‹</span> Projects
      </button>
      <div className="nt-divider" />
      <ProjectTitle />

      <span className="nt-spacer" />

      <div className="nt-group">
        <button className="nt-icon" onClick={s.undo} disabled={!s.canUndo} title="Undo (Ctrl+Z)">↶</button>
        <button className="nt-icon" onClick={s.redo} disabled={!s.canRedo} title="Redo (Ctrl+Shift+Z)">↷</button>
      </div>
      <div className="nt-divider" />
      <button className="nt-secondary" onClick={s.importMedia} title="Import video/audio">Import</button>

      <div className="nt-menu-wrap" ref={wrap}>
        <button className="nt-icon" onClick={() => setMenu((v) => !v)} title="More actions" aria-haspopup="menu" aria-expanded={menu}>⋯</button>
        {menu && (
          <div className="nt-menu" role="menu">
            <button className="nt-mi" onClick={() => run(s.load)}>Open project…</button>
            <button className="nt-mi" onClick={() => run(s.save)} disabled={!hasBase}>Save</button>
            {!IS_WEB && (
              <button className="nt-mi" onClick={() => run(s.transcribe)} disabled={!hasBase || s.job.active}>
                {s.project.transcript ? 'Re-transcribe' : 'Transcribe'}
              </button>
            )}
            <div className="nt-mi-sep" />
            <button className="nt-mi" onClick={() => run(() => { s.setToolsTab('silence'); s.detectSilence() })} disabled={!hasBase || s.job.active}>Detect silence</button>
            <button className="nt-mi" onClick={() => run(s.removeAllSilence)} disabled={!s.project.silences.length}>Remove all gaps</button>
            <div className="nt-mi-sep" />
            <div className="nt-mi-zoom">
              <span>Timeline zoom</span>
              <input
                type="range"
                min={10}
                max={300}
                value={s.project.pxPerSec}
                onChange={(e) => s.setZoom(Number(e.target.value))}
              />
            </div>
            <div className="nt-mi-sep" />
            <button className="nt-mi" onClick={() => run(() => s.setShowSettings(true))}>Settings &amp; shortcuts</button>
          </div>
        )}
      </div>

      <button
        className="nt-export primary"
        onClick={() => s.setShowExportModal(true)}
        disabled={!hasBase || s.job.active}
        title="Export your video"
      >
        Export
      </button>
    </div>
  )
}
