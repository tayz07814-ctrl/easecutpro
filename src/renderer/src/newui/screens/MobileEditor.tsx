import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { css } from '../css'
import { useStore } from '../../store'
import type { LibraryItem } from '@shared/types'
import VideoPreview from '../../components/VideoPreview'
import TimelinePanel from '../../components/timeline/TimelinePanel'
import RetakeCleanerPanel from './RetakeCleanerPanel'
import SilenceSettingsModal from './SilenceSettingsModal'
import ExportModal from '../../components/ExportModal'
import SettingsModal from '../../components/SettingsModal'
import { getSharedEngine, useSharedEngineSnapshot } from '../../timelineEngine'
import { primePlayback } from '../../clock'

// Mobile layout for the new UI editor. Reuses the production preview + mobile
// timeline (the same engine the desktop editor mounts) and the new Retake
// Cleaner / Silence Settings, arranged for a phone: stage on top, transport, the
// mobile timeline, and a bottom tab bar that opens sheets. Portrait-first.

const HAIR = 'rgba(255,255,255,.06)'
const ZOOM_MIN = 4
const ZOOM_MAX = 2000

type SheetKind = 'cut' | 'media' | null

function Sheet({ onClose, children, header }: { onClose: () => void; children: ReactNode; header?: ReactNode }): JSX.Element {
  return (
    <div onClick={onClose} style={css('position:fixed;inset:0;background:rgba(10,11,14,.6);z-index:1000;display:flex;flex-direction:column;justify-content:flex-end')}>
      <div onClick={(e) => e.stopPropagation()} style={css('background:#191B20;border-top:1px solid rgba(255,255,255,.09);border-radius:18px 18px 0 0;box-shadow:0 -14px 44px rgba(0,0,0,.55);display:flex;flex-direction:column;height:82vh;max-height:92vh')}>
        <div style={css('flex:none;display:grid;place-items:center;padding:8px 0 2px')}><div style={css('width:38px;height:4px;border-radius:2px;background:rgba(255,255,255,.18)')} /></div>
        {header}
        <div style={css('flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden')}>{children}</div>
      </div>
    </div>
  )
}

function MediaSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const library = useStore((s) => s.library)
  const basePath = useStore((s) => s.project.media?.path)
  const addToLibrary = useStore((s) => s.addToLibrary)
  const setBaseFromLibrary = useStore((s) => s.setBaseFromLibrary)
  const fmt = (it: LibraryItem): string => {
    const d = it.duration ? `${Math.floor(it.duration / 60)}:${String(Math.round(it.duration % 60)).padStart(2, '0')}` : ''
    return it.width && it.height ? `${d} · ${it.width}×${it.height}` : d
  }
  return (
    <Sheet
      onClose={onClose}
      header={
        <div style={css('flex:none;display:flex;align-items:center;justify-content:space-between;padding:6px 16px 12px')}>
          <div style={css('font-size:15px;font-weight:650')}>Media</div>
          <button onClick={addToLibrary} style={css('background:rgba(110,106,232,.16);border:1px solid rgba(110,106,232,.3);color:#B7B5F4;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:7px 14px;cursor:pointer')}>＋ Import</button>
        </div>
      }
    >
      <div style={css('flex:1;min-height:0;overflow:auto;padding:0 14px 20px;display:flex;flex-direction:column;gap:8px')}>
        {library.length === 0 && <div style={css('color:#686E7B;font-size:13px;text-align:center;padding:32px 0')}>No clips yet — tap ＋ Import to add videos.</div>}
        {library.map((it) => {
          const isBase = !!basePath && it.path === basePath
          return (
            <div key={it.id} onClick={() => { setBaseFromLibrary(it.id); onClose() }} style={css(`display:flex;gap:11px;align-items:center;padding:10px;border-radius:12px;background:#1E2026;border:1px solid ${isBase ? 'rgba(110,106,232,.55)' : 'rgba(255,255,255,.07)'};cursor:pointer`)}>
              <div style={css('width:44px;height:56px;flex:none;border-radius:7px;overflow:hidden;background:#23252b;display:grid;place-items:center')}>
                {it.thumb ? <img src={it.thumb} alt="" style={css('width:100%;height:100%;object-fit:cover')} /> : <span style={css("font-family:'IBM Plex Mono',monospace;font-size:9px;color:#686E7B")}>9:16</span>}
              </div>
              <div style={css('flex:1;min-width:0')}>
                <div style={css('font-size:13px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{it.name}</div>
                <div style={css("font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#686E7B;margin-top:3px")}>{fmt(it)}</div>
              </div>
              {isBase && <span style={css('font-size:10px;font-weight:600;color:#B7B5F4;background:rgba(110,106,232,.18);border-radius:5px;padding:2px 7px;flex:none')}>Base</span>}
            </div>
          )
        })}
      </div>
    </Sheet>
  )
}

function IcBtn({ label, onClick, disabled, active }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean }): JSX.Element {
  return (
    <button onClick={onClick} disabled={disabled} style={css(`width:34px;height:34px;border-radius:9px;border:1px solid ${active ? 'rgba(110,106,232,.4)' : 'transparent'};background:${active ? 'rgba(110,106,232,.16)' : 'transparent'};color:${disabled ? '#4A4F5B' : active ? '#B7B5F4' : '#C6C9D2'};font-size:16px;display:grid;place-items:center;cursor:${disabled ? 'default' : 'pointer'};font-family:inherit`)}>{label}</button>
  )
}

function zoomStep(factor: number): void {
  const e = getSharedEngine()
  if (e) e.setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, e.sessionState.zoom * factor)))
}

export default function MobileEditor(): JSX.Element {
  useSharedEngineSnapshot()
  const name = useStore((s) => s.project.name)
  const media = useStore((s) => s.project.media)
  const playing = useStore((s) => s.playing)
  const setPlaying = useStore((s) => s.setPlaying)
  const canUndo = useStore((s) => s.canUndo)
  const canRedo = useStore((s) => s.canRedo)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const goHome = useStore((s) => s.goHome)
  const setShowExportModal = useStore((s) => s.setShowExportModal)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setShowSilenceSettings = useStore((s) => s.setShowSilenceSettings)
  const showExportModal = useStore((s) => s.showExportModal)
  const showSettings = useStore((s) => s.showSettings)
  const [sheet, setSheet] = useState<SheetKind>(null)
  const hasBase = !!media || ((useStore.getState().project.baseSequence?.length ?? 0) > 0)

  const tab = (label: string, onClick: () => void, primary?: boolean): JSX.Element => (
    <button onClick={onClick} style={css(`flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 0 10px;background:none;border:none;color:${primary ? '#B7B5F4' : '#9BA0AC'};font-family:inherit;font-size:11px;font-weight:${primary ? 600 : 500};cursor:pointer`)}>{label}</button>
  )

  return (
    <div style={css('width:100%;height:100%;background:#17181C;display:flex;flex-direction:column;overflow:hidden')} className="ec-newui ec-m-editor">
      {/* Top bar */}
      <div style={css(`flex:none;display:flex;align-items:center;gap:8px;height:48px;padding:0 10px;border-bottom:1px solid ${HAIR}`)}>
        <div onClick={goHome} style={css('font-size:20px;color:#9BA0AC;padding:4px 8px;cursor:pointer')}>‹</div>
        <div style={css('flex:1;min-width:0;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{name}</div>
        <div onClick={() => setShowSettings(true)} style={css('color:#9BA0AC;font-size:16px;padding:4px 8px;cursor:pointer')}>···</div>
        <button onClick={() => setShowExportModal(true)} style={css('background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:7px 14px;cursor:pointer')}>Export</button>
      </div>

      {/* Stage — production preview (its own transport is hidden via CSS below) */}
      <div className="ec-legacy ec-m-stage" style={css('flex:1;min-height:0;display:flex;flex-direction:column;background:#000')}>
        <VideoPreview />
      </div>

      {/* Transport */}
      <div style={css(`flex:none;display:flex;align-items:center;gap:4px;padding:7px 10px;border-top:1px solid ${HAIR}`)}>
        <IcBtn label="↶" onClick={() => canUndo && undo()} disabled={!canUndo} />
        <IcBtn label="↷" onClick={() => canRedo && redo()} disabled={!canRedo} />
        <div style={css('flex:1')} />
        <button onClick={() => { if (!hasBase) return; const next = !playing; if (next) primePlayback(); setPlaying(next) }} disabled={!hasBase} style={css(`width:44px;height:44px;border-radius:50%;background:${hasBase ? '#E9EAEE' : '#2A2D36'};border:none;display:grid;place-items:center;cursor:${hasBase ? 'pointer' : 'default'}`)}>
          {playing
            ? <span style={css('display:flex;gap:3px')}><span style={css('width:4px;height:15px;background:#17181C;border-radius:1px')} /><span style={css('width:4px;height:15px;background:#17181C;border-radius:1px')} /></span>
            : <span style={css('width:0;height:0;border-left:12px solid #17181C;border-top:8px solid transparent;border-bottom:8px solid transparent;margin-left:3px')} />}
        </button>
        <div style={css('flex:1')} />
        <IcBtn label="−" onClick={() => zoomStep(1 / 1.4)} />
        <IcBtn label="＋" onClick={() => zoomStep(1.4)} />
      </div>

      {/* Mobile timeline */}
      <div className="ec-legacy ec-m-tl" style={css(`flex:none;height:172px;min-height:0;border-top:1px solid ${HAIR};position:relative`)}>
        <TimelinePanel mobile />
      </div>

      {/* Bottom tabs */}
      <div style={css(`flex:none;display:flex;border-top:1px solid ${HAIR};background:#191B20;padding-bottom:env(safe-area-inset-bottom)`)}>
        {tab('✦ Cut Lord', () => setSheet('cut'), true)}
        {tab('Media', () => setSheet('media'))}
        {tab('Silence', () => setShowSilenceSettings(true))}
        {tab('Export', () => setShowExportModal(true))}
      </div>

      {/* Sheets + modals */}
      {sheet === 'cut' && (
        <Sheet onClose={() => setSheet(null)}>
          <RetakeCleanerPanel />
        </Sheet>
      )}
      {sheet === 'media' && <MediaSheet onClose={() => setSheet(null)} />}
      <SilenceSettingsModal />
      {showExportModal && createPortal(<ExportModal />, document.body)}
      {showSettings && createPortal(<SettingsModal />, document.body)}
    </div>
  )
}
