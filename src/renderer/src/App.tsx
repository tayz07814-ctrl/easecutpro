import { useEffect, useState } from 'react'
import { useStore } from './store'
import Toolbar from './components/Toolbar'
import VideoPreview from './components/VideoPreview'
import MediaLibrary from './components/MediaLibrary'
import ToolsPanel from './components/ToolsPanel'
import TimelinePanel from './components/timeline/TimelinePanel'
import ProgressBar from './components/ProgressBar'
import SettingsModal from './components/SettingsModal'
import ExportModal from './components/ExportModal'
import MobileApp from './components/MobileApp'
import { useIsMobile } from './useMobile'

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
function num(key: string, def: number): number {
  const v = Number(localStorage.getItem(key))
  return v > 0 ? v : def
}

export default function App(): JSX.Element {
  const init = useStore((s) => s.init)
  const showSettings = useStore((s) => s.showSettings)
  const showExportModal = useStore((s) => s.showExportModal)
  const editingClipId = useStore((s) => s.editingClipId)
  const finishSequenceClipEdit = useStore((s) => s.finishSequenceClipEdit)
  const isMobile = useIsMobile()

  const [leftW, setLeftW] = useState(() => num('ec.leftW', 360))
  const [rightW, setRightW] = useState(() => num('ec.rightW', 310))
  const [timelineH, setTimelineH] = useState(() => num('ec.timelineH', 360))

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => localStorage.setItem('ec.leftW', String(leftW)), [leftW])
  useEffect(() => localStorage.setItem('ec.rightW', String(rightW)), [rightW])
  useEffect(() => localStorage.setItem('ec.timelineH', String(timelineH)), [timelineH])

  // Global shortcuts (user-configurable; ignored while typing in fields).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      if (useStore.getState().showSettings) return
      // Undo / redo (Ctrl/Cmd).
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) useStore.getState().redo()
        else useStore.getState().undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        useStore.getState().redo()
        return
      }
      if (e.ctrlKey || e.metaKey) return
      if (e.repeat) return
      const kb = useStore.getState().keybinds
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (key === kb.split.toLowerCase()) {
        e.preventDefault()
        useStore.getState().hotkeySplit()
      } else if (key === kb.del.toLowerCase()) {
        e.preventDefault()
        useStore.getState().hotkeyDelete()
      } else if (key === kb.undelete.toLowerCase()) {
        e.preventDefault()
        useStore.getState().hotkeyUndelete()
      } else if (e.key === kb.playPause || key === kb.playPause.toLowerCase()) {
        e.preventDefault()
        useStore.getState().hotkeyPlayPause()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function startColDrag(e: React.MouseEvent, which: 'left' | 'right'): void {
    e.preventDefault()
    const startX = e.clientX
    const l0 = leftW
    const r0 = rightW
    function onMove(ev: MouseEvent): void {
      const dx = ev.clientX - startX
      if (which === 'left') setLeftW(clamp(l0 + dx, 240, 620))
      else setRightW(clamp(r0 - dx, 220, 580))
    }
    function onUp(): void {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function startTimelineDrag(e: React.MouseEvent): void {
    e.preventDefault()
    const startY = e.clientY
    const h0 = timelineH
    function onMove(ev: MouseEvent): void {
      setTimelineH(clamp(h0 - (ev.clientY - startY), 200, 760))
    }
    function onUp(): void {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (isMobile) return <MobileApp />

  return (
    <div className="app">
      <Toolbar />
      {editingClipId && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '6px 14px',
            background: '#2f2710',
            borderBottom: '1px solid #6b5a1a',
            color: '#ffe9a8',
            fontSize: 13
          }}
        >
          <span>✎ Editing a montage clip — transcribe &amp; clean it, then save back to the montage.</span>
          <button className="primary" onClick={finishSequenceClipEdit}>✓ Done</button>
        </div>
      )}
      <div className="main">
        <div className="col-left" style={{ width: leftW }}>
          <MediaLibrary />
        </div>
        <div className="divider-v" onMouseDown={(e) => startColDrag(e, 'left')} />
        <div className="col-center">
          <VideoPreview />
        </div>
        <div className="divider-v" onMouseDown={(e) => startColDrag(e, 'right')} />
        <div className="col-right" style={{ width: rightW }}>
          <ToolsPanel />
        </div>
      </div>
      <div className="row-divider" onMouseDown={startTimelineDrag} title="Drag to resize timeline" />
      <div className="timeline-host" style={{ height: timelineH }}>
        <TimelinePanel />
      </div>
      <ProgressBar />
      {showSettings && <SettingsModal />}
      {showExportModal && <ExportModal />}
    </div>
  )
}
