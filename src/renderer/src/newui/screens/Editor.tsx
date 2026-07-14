import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { css } from '../css'
import { useStore } from '../../store'
import type { LibraryItem } from '@shared/types'
import RetakeCleanerPanel from './RetakeCleanerPanel'
import SilenceSettingsModal from './SilenceSettingsModal'
import ExportModal from '../../components/ExportModal'
import SettingsModal from '../../components/SettingsModal'
import VideoPreview from '../../components/VideoPreview'
import TimelinePanel from '../../components/timeline/TimelinePanel'
import { getSharedEngine, useSharedEngineSnapshot } from '../../timelineEngine'

function fmtDur(s: number): string {
  if (!s || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

// Screen 1b — Video editor. The SHELL (topbar, media rail, AI panel) is the
// approved redesign; the editor CORE (preview + timeline + export) is the live
// app's own VideoPreview + TimelinePanel + ExportModal, which all share ONE
// timeline engine. That's why cuts, drag/trim/split and export behave exactly
// like production here — there is no separate cut model to drift out of sync
// (the earlier hybrid preview was what left "massive non-cut clips").

const HAIR = 'rgba(255,255,255,.06)'
const CLIP9x16 =
  "width:42px;height:74px;flex:none;border-radius:7px;background:repeating-linear-gradient(45deg,#23252b 0,#23252b 8px,#1e2026 8px,#1e2026 16px);display:grid;place-items:center;font-family:'IBM Plex Mono',monospace;font-size:8px;color:#686E7B"

// saveState → the design's status dot + label (green Saved / amber Saving / red failed).
const SAVE_UI: Record<string, { c: string; t: string }> = {
  idle: { c: '#46A57C', t: 'Saved' },
  saved: { c: '#46A57C', t: 'Saved' },
  saving: { c: '#D9A44A', t: 'Saving…' },
  error: { c: '#D9686E', t: 'Save failed' }
}

// Persisted panel sizes for the drag handles below. Namespaced ec.nu.* so they
// never collide with the legacy editor's own ec.leftW / ec.rightW / ec.timelineH.
function num(key: string, def: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return v > 0 ? v : def
  } catch {
    return def
  }
}
function clampN(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function TopBar(): JSX.Element {
  const name = useStore((s) => s.project.name)
  const saveState = useStore((s) => s.saveState)
  const canUndo = useStore((s) => s.canUndo)
  const canRedo = useStore((s) => s.canRedo)
  const goHome = useStore((s) => s.goHome)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const importMedia = useStore((s) => s.importMedia)
  const rename = useStore((s) => s.renameCurrentProject)
  const setShowExportModal = useStore((s) => s.setShowExportModal)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const sv = SAVE_UI[saveState] ?? SAVE_UI.saved

  return (
    <div style={css(`display:flex;align-items:center;gap:12px;height:52px;padding:0 16px;border-bottom:1px solid ${HAIR};flex:none`)}>
      <div onClick={goHome} style={css('display:flex;align-items:center;gap:7px;font-size:13px;color:#9BA0AC;padding:6px 10px;border-radius:8px;cursor:pointer')}>
        <span style={css('font-size:14px')}>‹</span> Projects
      </div>
      <div style={css('width:1px;height:20px;background:rgba(255,255,255,.08)')} />
      <div style={css('display:flex;align-items:center;gap:8px')}>
        <div
          contentEditable
          suppressContentEditableWarning
          onBlur={(e) => {
            const v = e.currentTarget.textContent?.trim()
            if (v && v !== name) rename(v)
            else e.currentTarget.textContent = name
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
          }}
          style={css('font-size:13.5px;font-weight:600;padding:5px 8px;border-radius:8px;cursor:text;outline:none')}
        >
          {name}
        </div>
        <div style={css('display:flex;align-items:center;gap:5px;font-size:11.5px;color:#686E7B')}>
          <div style={css(`width:6px;height:6px;border-radius:50%;background:${sv.c}`)} />{sv.t}
        </div>
      </div>
      <div style={css('flex:1')} />
      <div style={css('display:flex;align-items:center;gap:4px')}>
        <div onClick={() => canUndo && undo()} style={css(`width:30px;height:30px;border-radius:8px;display:grid;place-items:center;font-size:14px;color:${canUndo ? '#9BA0AC' : '#4A4F5B'};cursor:${canUndo ? 'pointer' : 'default'}`)}>↶</div>
        <div onClick={() => canRedo && redo()} style={css(`width:30px;height:30px;border-radius:8px;display:grid;place-items:center;font-size:14px;color:${canRedo ? '#9BA0AC' : '#4A4F5B'};cursor:${canRedo ? 'pointer' : 'default'}`)}>↷</div>
      </div>
      <div style={css('width:1px;height:20px;background:rgba(255,255,255,.08)')} />
      <button onClick={importMedia} style={css('background:none;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:9px;padding:7px 13px;cursor:pointer')}>Import</button>
      <div onClick={() => setShowSettings(true)} style={css('width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:#9BA0AC;font-size:15px;cursor:pointer')}>···</div>
      <button onClick={() => setShowExportModal(true)} style={css('background:#6E6AE8;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:7px 16px;cursor:pointer')}>Export</button>
    </div>
  )
}

function MediaClip({ item, isBase, onSetBase, onRemove }: { item: LibraryItem; isBase: boolean; onSetBase: () => void; onRemove: () => void }): JSX.Element {
  const shell = isBase
    ? 'background:#1E2026;border:1px solid rgba(110,106,232,.55);border-radius:12px;padding:10px;display:flex;gap:10px;box-shadow:0 0 0 3px rgba(110,106,232,.12);position:relative;cursor:pointer'
    : 'background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:10px;display:flex;gap:10px;cursor:pointer'
  const meta = item.width && item.height ? `${fmtDur(item.duration)} · ${item.width}×${item.height}` : fmtDur(item.duration)
  return (
    <div onClick={onSetBase} style={css(shell)}>
      <div style={css(CLIP9x16)}>{item.thumb ? <img src={item.thumb} alt="" style={css('width:100%;height:100%;object-fit:cover;border-radius:7px')} draggable={false} /> : '9:16'}</div>
      <div style={css('flex:1;min-width:0;display:flex;flex-direction:column;gap:4px')}>
        <div style={css('font-size:12.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')} title={item.name}>{item.name}</div>
        <div style={css("font-family:'IBM Plex Mono',monospace;font-size:10px;color:#686E7B")}>{meta}</div>
        {isBase && (
          <div style={css('display:flex;gap:6px;margin-top:2px')}>
            <span style={css('font-size:10px;font-weight:600;color:#B7B5F4;background:rgba(110,106,232,.18);border-radius:5px;padding:2px 7px')}>Base clip</span>
          </div>
        )}
      </div>
      <div onClick={(e) => { e.stopPropagation(); onRemove() }} style={css('color:#9BA0AC;font-size:14px;line-height:1;height:22px;padding:2px 5px;border-radius:6px;cursor:pointer')}>···</div>
    </div>
  )
}

function MediaPanel({ width }: { width: number }): JSX.Element {
  const library = useStore((s) => s.library)
  const basePath = useStore((s) => s.project.media?.path)
  const addToLibrary = useStore((s) => s.addToLibrary)
  const setBaseFromLibrary = useStore((s) => s.setBaseFromLibrary)
  const removeFromLibrary = useStore((s) => s.removeFromLibrary)
  const [filter, setFilter] = useState('')

  const q = filter.trim().toLowerCase()
  const items = q ? library.filter((it) => it.name.toLowerCase().includes(q)) : library

  return (
    <div style={css(`width:${width}px;flex:none;display:flex;flex-direction:column;background:#191B20`)}>
      <div style={css('display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px')}>
        <div style={css('font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9BA0AC')}>Media</div>
        <div style={css('font-size:13px;color:#686E7B;cursor:pointer')}>⟨</div>
      </div>
      <div style={css('padding:0 16px 12px;display:flex;flex-direction:column;gap:8px')}>
        <button onClick={addToLibrary} style={css('background:rgba(110,106,232,.14);border:1px solid rgba(110,106,232,.3);color:#B7B5F4;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:8px 0;cursor:pointer;width:100%')}>＋ Import media</button>
        <div style={css('display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;background:#1E2026;border:1px solid rgba(255,255,255,.06);border-radius:8px')}>
          <div style={css('width:10px;height:10px;border:1.5px solid #686E7B;border-radius:50%;position:relative')}>
            <div style={css('position:absolute;width:4px;height:1.5px;background:#686E7B;bottom:-2px;right:-2px;transform:rotate(45deg)')} />
          </div>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter media" style={css('font-size:12px;color:#E9EAEE;flex:1;min-width:0;background:none;border:none;outline:none;font-family:inherit;padding:0;margin:0')} />
        </div>
      </div>
      <div style={css('padding:0 12px;display:flex;flex-direction:column;gap:8px;overflow:hidden')}>
        {items.map((it) => (
          <MediaClip
            key={it.id}
            item={it}
            isBase={!!basePath && it.path === basePath}
            onSetBase={() => setBaseFromLibrary(it.id)}
            onRemove={() => removeFromLibrary(it.id)}
          />
        ))}
      </div>
      <div style={css('flex:1')} />
      <div style={css('padding:14px 16px;font-size:11px;line-height:1.5;color:#686E7B;border-top:1px solid rgba(255,255,255,.05)')}>Import once, reuse anywhere. Set a clip as base, or drag it onto a track.</div>
    </div>
  )
}

// Only the AI Cut tab has approved design content. The others (Edit/Text/
// Overlays/Audio) are wired for active-state + selection but their panels await
// design (and the "Audio" ↔ silence/ost mapping decision), so they show an
// honest placeholder rather than mounting off-design legacy panels.
const AI_TABS = ['AI Cut', 'Edit', 'Text', 'Overlays', 'Audio'] as const

function AiPanel({ width }: { width: number }): JSX.Element {
  const [tab, setTab] = useState<(typeof AI_TABS)[number]>('AI Cut')
  return (
    <div style={css(`width:${width}px;flex:none;display:flex;flex-direction:column;background:#191B20`)}>
      <div style={css(`display:flex;padding:0 8px;border-bottom:1px solid ${HAIR};flex:none`)}>
        {AI_TABS.map((t) =>
          t === tab ? (
            <div key={t} style={css('padding:13px 12px 11px;font-size:12.5px;font-weight:600;color:#E9EAEE;border-bottom:2px solid #6E6AE8;margin-bottom:-1px')}>{t}</div>
          ) : (
            <div key={t} onClick={() => setTab(t)} style={css('padding:13px 12px 11px;font-size:12.5px;color:#9BA0AC;cursor:pointer')}>{t}</div>
          )
        )}
      </div>
      {tab === 'AI Cut' ? (
        <RetakeCleanerPanel />
      ) : (
        <div style={css('flex:1;display:grid;place-items:center;padding:24px;text-align:center')}>
          <div style={css('font-size:12.5px;color:#686E7B;line-height:1.6')}>{tab} tools are coming to the new editor.</div>
        </div>
      )}
    </div>
  )
}

// Visible timeline zoom. The production timeline only zooms via Ctrl+wheel — no
// on-screen control, and nothing at all on touch. This floating −/＋ drives the
// SAME shared TimelineEngine the wheel does (single source of truth), and
// re-renders via useSharedEngineSnapshot so it stays in sync with wheel zoom.
const ZOOM_MIN = 4
const ZOOM_MAX = 2000
function TimelineZoom(): JSX.Element | null {
  useSharedEngineSnapshot()
  const eng = getSharedEngine()
  if (!eng) return null
  const zoom = eng.sessionState.zoom
  const atMin = zoom <= ZOOM_MIN + 0.01
  const atMax = zoom >= ZOOM_MAX - 0.01
  const step = (factor: number) => (): void => {
    const e = getSharedEngine()
    if (e) e.setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, e.sessionState.zoom * factor)))
  }
  const btn = (dis: boolean): string =>
    `width:28px;height:28px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:#1E2026;color:${dis ? '#4A4F5B' : '#C6C9D2'};font-size:16px;line-height:1;display:grid;place-items:center;cursor:${dis ? 'default' : 'pointer'};font-family:inherit`
  return (
    <div style={css('position:absolute;bottom:10px;right:14px;z-index:20;display:flex;align-items:center;gap:5px;background:rgba(20,21,25,.85);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:4px 5px')}>
      <button title="Zoom out" onClick={step(1 / 1.4)} disabled={atMin} style={css(btn(atMin))}>−</button>
      <button title="Zoom in" onClick={step(1.4)} disabled={atMax} style={css(btn(atMax))}>＋</button>
    </div>
  )
}

export default function Editor(): JSX.Element {
  const showExportModal = useStore((s) => s.showExportModal)
  const showSettings = useStore((s) => s.showSettings)

  // Creator-resizable panels (drag handles below), persisted per browser.
  const [leftW, setLeftW] = useState(() => num('ec.nu.leftW', 264))
  const [rightW, setRightW] = useState(() => num('ec.nu.rightW', 360))
  const [timelineH, setTimelineH] = useState(() => num('ec.nu.timelineH', 300))
  useEffect(() => { try { localStorage.setItem('ec.nu.leftW', String(leftW)) } catch { /* ignore */ } }, [leftW])
  useEffect(() => { try { localStorage.setItem('ec.nu.rightW', String(rightW)) } catch { /* ignore */ } }, [rightW])
  useEffect(() => { try { localStorage.setItem('ec.nu.timelineH', String(timelineH)) } catch { /* ignore */ } }, [timelineH])

  // Pointer drag (mouse + touch): lock the cursor and kill text selection for the
  // whole gesture so the drag reads smoothly and doesn't highlight the UI.
  function beginDrag(cursor: string, onMove: (e: PointerEvent) => void): void {
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = cursor
    document.body.style.userSelect = 'none'
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  function startColDrag(e: ReactPointerEvent, which: 'left' | 'right'): void {
    e.preventDefault()
    const startX = e.clientX
    const l0 = leftW
    const r0 = rightW
    beginDrag('col-resize', (ev) => {
      const dx = ev.clientX - startX
      if (which === 'left') setLeftW(clampN(l0 + dx, 200, 480))
      else setRightW(clampN(r0 - dx, 300, 560))
    })
  }
  function startRowDrag(e: ReactPointerEvent): void {
    e.preventDefault()
    const startY = e.clientY
    const h0 = timelineH
    beginDrag('row-resize', (ev) => setTimelineH(clampN(h0 - (ev.clientY - startY), 160, 620)))
  }

  return (
    <div style={css('width:100%;height:100%;background:#17181C;display:flex;flex-direction:column')} className="ec-newui ec-editor">
      <TopBar />
      <div style={css('display:flex;flex:1;min-height:0')}>
        <MediaPanel width={leftW} />
        <div className="ec-divv" onPointerDown={(e) => startColDrag(e, 'left')} title="Drag to resize" />
        {/* Live editor core — the production preview. `.ec-legacy` restores the
            app's border-box model (the .ec-newui content-box reset would leak in
            and break the legacy layout). It reads the SAME shared timeline engine
            the timeline below publishes, so playback reflects the real edit. */}
        <div className="ec-legacy" style={css('flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:#000')}>
          <VideoPreview />
        </div>
        <div className="ec-divv" onPointerDown={(e) => startColDrag(e, 'right')} title="Drag to resize" />
        <AiPanel width={rightW} />
      </div>
      <div className="ec-divh" onPointerDown={startRowDrag} title="Drag to resize" />
      {/* Live editor core — the production timeline. Publishes the timeline engine
          that the preview + export read, so drag/trim/split and word/silence cuts
          all stay consistent (exactly the live app's behavior). */}
      <div className="ec-legacy timeline-host" style={css(`flex:none;height:${timelineH}px;min-height:0;position:relative`)}>
        <TimelinePanel />
        <TimelineZoom />
      </div>
      <SilenceSettingsModal />
      {/* Legacy modals assume the app's global border-box — portal them out of
          the .ec-newui (content-box) subtree so they render correctly. */}
      {showExportModal && createPortal(<ExportModal />, document.body)}
      {showSettings && createPortal(<SettingsModal />, document.body)}
    </div>
  )
}
