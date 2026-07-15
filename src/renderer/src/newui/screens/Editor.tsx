import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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
import { primePlayback } from '../../clock'
import { framesToSeconds, secondsToFrames } from '@shared/timeline/time'
import { createClip, mainTrackId } from '@shared/timeline/model'
import * as C from '@shared/timeline/commands'
import type { Command } from '@shared/timeline/commands'
import { uid } from '@shared/timeline/ids'

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

// Resizable-panel bounds. Only the LEFT/RIGHT panels resize (the timeline is a
// fixed, viewport-proportional container with its own internal scroll). Widths are
// clamped to BOTH an absolute cap and a viewport-aware cap that always reserves
// MIN_PREVIEW for the centre preview — so widening a panel can never crush the
// preview or clip its transport controls.
const MIN_LEFT = 200
const MAX_LEFT = 480
const MIN_RIGHT = 300
const MAX_RIGHT = 560
const MIN_PREVIEW = 420 // keeps the preview + its full transport row intact when panels widen
const HANDLE = 6 // .ec-divv thickness
// Timeline height = this fraction of the editor height, clamped — enough for the
// default lanes, never a tall empty void; extra tracks scroll inside the panel.
const TL_FRACTION = 0.38
const TL_MIN = 240
const TL_MAX = 360

const CLIP9x16 =
  "width:42px;height:74px;flex:none;border-radius:7px;background:repeating-linear-gradient(45deg,#23252b 0,#23252b 8px,#1e2026 8px,#1e2026 16px);display:grid;place-items:center;font-family:'IBM Plex Mono',monospace;font-size:8px;color:#686E7B"

// Small control glyphs drawn as SVG (not Unicode text) so they sit dead-centre in
// the tiny square buttons — the +/−/list/grid characters never optically centre
// (the fullwidth ＋ especially sits off to one side). They inherit `currentColor`.
const icoStyle = { display: 'block' } as const
const IcMinus = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={icoStyle}><path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
)
const IcPlus = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={icoStyle}><path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
)
const IcList = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={icoStyle}><path d="M2 3.5h9M2 6.5h9M2 9.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
)
const IcGrid = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor" style={icoStyle}>
    <rect x="2" y="2" width="3.6" height="3.6" rx="0.8" />
    <rect x="7.4" y="2" width="3.6" height="3.6" rx="0.8" />
    <rect x="2" y="7.4" width="3.6" height="3.6" rx="0.8" />
    <rect x="7.4" y="7.4" width="3.6" height="3.6" rx="0.8" />
  </svg>
)

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

// Append a library clip to the END of the timeline: video/image → the main (base)
// lane, audio → an audio lane — through the SAME engine path drag-drop uses, so
// existing clips are preserved (this is NOT the old behavior that rebuilt the base
// and wiped the others). No-op until the engine + a target lane are ready.
function addMediaToTimeline(item: LibraryItem): void {
  const engine = getSharedEngine()
  if (!engine) return
  const doc = engine.document
  const tb = doc.timebase
  const isImage = item.kind === 'image'
  const isAudio = item.kind === 'audio'
  const durSec = isImage ? 4 : item.duration || 4
  const kind = isImage ? 'image' : isAudio ? 'audio' : 'video'
  const mainId = mainTrackId(doc)
  const cmds: Command[] = []
  let trackId = mainId ?? doc.tracks[0]?.id ?? ''
  if (isAudio) {
    const a = doc.tracks.find((t) => t.kind === 'audio')
    if (a) trackId = a.id
    else {
      trackId = uid('track')
      cmds.push(C.addTrack('audio', { id: trackId }))
    }
  }
  if (!trackId) return
  const lane = doc.tracks.find((t) => t.id === trackId)
  const endFrame = lane ? lane.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) : 0
  const clip = createClip({
    kind,
    trackId,
    start: endFrame,
    duration: secondsToFrames(durSec, tb),
    sourcePath: item.path,
    sourceIn: 0,
    sourceOut: durSec,
    sourceDuration: isImage ? 3600 : item.duration || durSec,
    srcW: item.width,
    srcH: item.height,
    srcFps: item.fps,
    name: item.name,
    hasAudio: item.hasAudio
  })
  cmds.push(trackId === mainId ? C.insertToMain(clip, endFrame) : C.addClip(clip))
  engine.batch('Add clip', cmds)
  engine.select([clip.id])
}

// A library clip. CLICK appends it to the timeline (main/base lane) and DRAG drops
// it onto a specific lane/position — both preserve existing clips. Renders as a
// list row or a grid tile.
function MediaClip({ item, isBase, grid, onRemove }: { item: LibraryItem; isBase: boolean; grid?: boolean; onRemove: () => void }): JSX.Element {
  const onDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.setData('application/x-ec-media', item.id)
    e.dataTransfer.effectAllowed = 'copy'
  }
  const onClick = (): void => addMediaToTimeline(item)
  const meta = item.width && item.height ? `${fmtDur(item.duration)} · ${item.width}×${item.height}` : fmtDur(item.duration)

  if (grid) {
    return (
      <div draggable onDragStart={onDragStart} onClick={onClick} title={`${item.name} — click to add, or drag onto the timeline`} style={css(`background:#1E2026;border:1px solid ${isBase ? 'rgba(110,106,232,.55)' : 'rgba(255,255,255,.07)'};border-radius:11px;overflow:hidden;cursor:grab;${isBase ? 'box-shadow:0 0 0 3px rgba(110,106,232,.12);' : ''}`)}>
        <div style={css('position:relative;aspect-ratio:9/16;max-height:150px;background:#15161a;display:grid;place-items:center')}>
          {item.thumb ? <img src={item.thumb} alt="" draggable={false} style={css('width:100%;height:100%;object-fit:cover')} /> : <span style={css("font-family:'IBM Plex Mono',monospace;font-size:10px;color:#686E7B")}>9:16</span>}
          <span style={css("position:absolute;right:5px;bottom:5px;font-family:'IBM Plex Mono',monospace;font-size:9px;color:#E9EAEE;background:rgba(13,14,17,.72);border-radius:5px;padding:2px 5px")}>{fmtDur(item.duration)}</span>
          {isBase && <span style={css('position:absolute;left:5px;top:5px;font-size:9px;font-weight:600;color:#fff;background:rgba(110,106,232,.9);border-radius:5px;padding:2px 6px')}>Base</span>}
        </div>
        <div style={css('display:flex;align-items:center;gap:2px;padding:6px 6px 7px')}>
          <div style={css('flex:1;min-width:0;font-size:11px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')} title={item.name}>{item.name}</div>
          <div onClick={(e) => { e.stopPropagation(); onRemove() }} style={css('color:#9BA0AC;font-size:13px;line-height:1;padding:0 3px;cursor:pointer')}>···</div>
        </div>
      </div>
    )
  }

  const shell = isBase
    ? 'background:#1E2026;border:1px solid rgba(110,106,232,.55);border-radius:12px;padding:10px;display:flex;gap:10px;box-shadow:0 0 0 3px rgba(110,106,232,.12);position:relative;cursor:grab'
    : 'background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:10px;display:flex;gap:10px;cursor:grab'
  return (
    <div draggable onDragStart={onDragStart} onClick={onClick} title={`${item.name} — click to add, or drag onto the timeline`} style={css(shell)}>
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
  const removeFromLibrary = useStore((s) => s.removeFromLibrary)
  const addAllToTimeline = useStore((s) => s.addAllToTimeline)
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<'list' | 'grid'>('list')

  const q = filter.trim().toLowerCase()
  const items = q ? library.filter((it) => it.name.toLowerCase().includes(q)) : library
  const canSequence = library.some((it) => it.kind === 'video' || it.kind === 'image')

  return (
    <div style={css(`width:${width}px;flex:none;min-width:0;display:flex;flex-direction:column;background:#191B20;overflow:hidden`)}>
      <div style={css('display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px')}>
        <div style={css('font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9BA0AC')}>Media</div>
        <div style={css('display:flex;align-items:center;gap:8px')}>
          <div style={css('display:flex;gap:2px;background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:7px;padding:2px')}>
            <button onClick={() => setView('list')} title="List view" style={css(`width:24px;height:20px;border:none;border-radius:5px;cursor:pointer;padding:0;appearance:none;-webkit-appearance:none;display:grid;place-items:center;background:${view === 'list' ? 'rgba(110,106,232,.25)' : 'transparent'};color:${view === 'list' ? '#B7B5F4' : '#9BA0AC'}`)}><IcList /></button>
            <button onClick={() => setView('grid')} title="Grid view" style={css(`width:24px;height:20px;border:none;border-radius:5px;cursor:pointer;padding:0;appearance:none;-webkit-appearance:none;display:grid;place-items:center;background:${view === 'grid' ? 'rgba(110,106,232,.25)' : 'transparent'};color:${view === 'grid' ? '#B7B5F4' : '#9BA0AC'}`)}><IcGrid /></button>
          </div>
          <div style={css('font-size:13px;color:#686E7B;cursor:pointer')}>⟨</div>
        </div>
      </div>
      <div style={css('padding:0 16px 12px;display:flex;flex-direction:column;gap:8px')}>
        <button onClick={addToLibrary} style={css('background:rgba(110,106,232,.14);border:1px solid rgba(110,106,232,.3);color:#B7B5F4;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:8px 0;cursor:pointer;width:100%')}>＋ Import media</button>
        {canSequence && (
          <button onClick={addAllToTimeline} title="Add every video/image to the timeline as one sequence, in order" style={css('background:none;border:1px solid rgba(255,255,255,.12);color:#C6C9D2;font-family:inherit;font-size:12.5px;font-weight:550;border-radius:9px;padding:8px 0;cursor:pointer;width:100%')}>▦ Add all to timeline</button>
        )}
        <div style={css('display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;background:#1E2026;border:1px solid rgba(255,255,255,.06);border-radius:8px')}>
          <div style={css('width:10px;height:10px;border:1.5px solid #686E7B;border-radius:50%;position:relative')}>
            <div style={css('position:absolute;width:4px;height:1.5px;background:#686E7B;bottom:-2px;right:-2px;transform:rotate(45deg)')} />
          </div>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter media" style={css('font-size:12px;color:#E9EAEE;flex:1;min-width:0;background:none;border:none;outline:none;font-family:inherit;padding:0;margin:0')} />
        </div>
      </div>
      <div style={css('flex:1;min-height:0;padding:0 12px 12px;overflow-y:auto')}>
        {items.length === 0 ? (
          <div style={css('color:#686E7B;font-size:12px;text-align:center;padding:24px 8px')}>
            {library.length === 0 ? 'No media yet — tap ＋ Import media to add clips.' : 'No clips match your filter.'}
          </div>
        ) : view === 'grid' ? (
          <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:8px')}>
            {items.map((it) => (
              <MediaClip key={it.id} item={it} grid isBase={!!basePath && it.path === basePath} onRemove={() => removeFromLibrary(it.id)} />
            ))}
          </div>
        ) : (
          <div style={css('display:flex;flex-direction:column;gap:8px')}>
            {items.map((it) => (
              <MediaClip key={it.id} item={it} isBase={!!basePath && it.path === basePath} onRemove={() => removeFromLibrary(it.id)} />
            ))}
          </div>
        )}
      </div>
      <div style={css('flex:none;padding:14px 16px;font-size:11px;line-height:1.5;color:#686E7B;border-top:1px solid rgba(255,255,255,.05)')}>Drag a clip onto the timeline to add it. Drag clips on the timeline to reorder them.</div>
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
    <div style={css(`width:${width}px;flex:none;min-width:0;display:flex;flex-direction:column;background:#191B20;overflow:hidden`)}>
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
    `width:28px;height:28px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:#1E2026;color:${dis ? '#4A4F5B' : '#C6C9D2'};font-size:16px;line-height:1;padding:0;appearance:none;-webkit-appearance:none;display:grid;place-items:center;cursor:${dis ? 'default' : 'pointer'};font-family:inherit`
  return (
    <div style={css('position:absolute;bottom:10px;right:14px;z-index:20;display:flex;align-items:center;gap:5px;background:rgba(20,21,25,.85);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:4px 5px')}>
      <button title="Zoom out" onClick={step(1 / 1.4)} disabled={atMin} style={css(btn(atMin))}><IcMinus /></button>
      <button title="Zoom in" onClick={step(1.4)} disabled={atMax} style={css(btn(atMax))}><IcPlus /></button>
    </div>
  )
}

export default function Editor(): JSX.Element {
  const showExportModal = useStore((s) => s.showExportModal)
  const showSettings = useStore((s) => s.showSettings)

  // Transport keyboard shortcuts (CapCut-style). GLOBAL so Space works the moment
  // the editor loads — no need to click the play button first (clicking only worked
  // before because it focused the button and Space re-triggered it). Ignored while
  // typing in a field. The timeline owns the editing keys (split S, Delete, ←/→
  // frame-step, ⌘Z undo/redo, copy/paste); these are the play-head/transport keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return // leave ⌘/Ctrl combos to the timeline
      if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'k' || e.key === 'K') {
        e.preventDefault() // no page scroll, and suppress a focused button's own Space
        const st = useStore.getState()
        if (!st.playing) primePlayback()
        st.setPlaying(!st.playing)
      } else if (e.key === 'Home') {
        e.preventDefault()
        useStore.getState().setPlayhead(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        const doc = getSharedEngine()?.document
        const main = doc?.tracks.find((t) => t.isMain)
        const endFrames = main ? main.clips.reduce((a, c) => Math.max(a, c.start + c.duration), 0) : 0
        if (doc) useStore.getState().setPlayhead(framesToSeconds(endFrames, doc.timebase))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The LEFT/RIGHT panels resize (persisted). The timeline is NOT draggable — it's
  // a fixed, viewport-proportional container with its own internal scroll.
  const [leftW, setLeftW] = useState(() => num('ec.nu.leftW', 264))
  const [rightW, setRightW] = useState(() => num('ec.nu.rightW', 360))
  const [timelineH, setTimelineH] = useState(TL_MIN)
  useEffect(() => { try { localStorage.setItem('ec.nu.leftW', String(leftW)) } catch { /* ignore */ } }, [leftW])
  useEffect(() => { try { localStorage.setItem('ec.nu.rightW', String(rightW)) } catch { /* ignore */ } }, [rightW])

  // Measured live so every clamp is viewport-aware (the preview never drops below
  // MIN_PREVIEW, which also keeps its transport row intact).
  const rootRef = useRef<HTMLDivElement>(null)
  const middleRef = useRef<HTMLDivElement>(null)

  // Widest a panel may be right now: its absolute cap, but never so wide that the
  // centre preview drops below MIN_PREVIEW (the OTHER panel is fixed during a drag).
  const maxLeftPx = (rightPx: number): number => {
    const midW = middleRef.current?.clientWidth ?? window.innerWidth
    return Math.max(MIN_LEFT, Math.min(MAX_LEFT, midW - 2 * HANDLE - rightPx - MIN_PREVIEW))
  }
  const maxRightPx = (leftPx: number): number => {
    const midW = middleRef.current?.clientWidth ?? window.innerWidth
    return Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, midW - 2 * HANDLE - leftPx - MIN_PREVIEW))
  }

  // Re-clamp on mount + window resize: keep the preview >= MIN_PREVIEW (shrinking
  // the panels right-then-left) and derive the fixed timeline height from the
  // viewport. Held in a ref so the resize listener binds once yet sees fresh sizes.
  const clampRef = useRef<() => void>(() => undefined)
  clampRef.current = (): void => {
    const mid = middleRef.current
    if (!mid) return
    const midW = mid.clientWidth
    let L = clampN(leftW, MIN_LEFT, MAX_LEFT)
    let R = clampN(rightW, MIN_RIGHT, MAX_RIGHT)
    let over = L + R + 2 * HANDLE + MIN_PREVIEW - midW
    if (over > 0) { const c = Math.min(over, R - MIN_RIGHT); R -= c; over -= c }
    if (over > 0) { const c = Math.min(over, L - MIN_LEFT); L -= c; over -= c }
    if (L !== leftW) setLeftW(L)
    if (R !== rightW) setRightW(R)
    const ch = rootRef.current?.clientHeight ?? window.innerHeight
    setTimelineH(clampN(Math.round(ch * TL_FRACTION), TL_MIN, TL_MAX))
  }
  useEffect(() => {
    const fn = (): void => clampRef.current()
    fn()
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])

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
    const maxL = maxLeftPx(r0)
    const maxR = maxRightPx(l0)
    beginDrag('col-resize', (ev) => {
      const dx = ev.clientX - startX
      if (which === 'left') setLeftW(clampN(l0 + dx, MIN_LEFT, maxL))
      else setRightW(clampN(r0 - dx, MIN_RIGHT, maxR))
    })
  }

  return (
    <div ref={rootRef} style={css('width:100%;height:100%;background:#17181C;display:flex;flex-direction:column;overflow:hidden')} className="ec-newui ec-editor">
      <TopBar />
      <div ref={middleRef} style={css('display:flex;flex:1;min-height:0;min-width:0')}>
        <MediaPanel width={leftW} />
        <div className="ec-divv" onPointerDown={(e) => startColDrag(e, 'left')} title="Drag to resize" />
        {/* Live editor core — the production preview. `.ec-legacy` restores the
            app's border-box model (the .ec-newui content-box reset would leak in
            and break the legacy layout). It reads the SAME shared timeline engine
            the timeline below publishes, so playback reflects the real edit. */}
        <div className="ec-legacy" style={css('flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:#17181C')}>
          <VideoPreview />
        </div>
        <div className="ec-divv" onPointerDown={(e) => startColDrag(e, 'right')} title="Drag to resize" />
        <AiPanel width={rightW} />
      </div>
      {/* Live editor core — the production timeline. A FIXED-height container with
          its OWN internal scroll (Timeline's .ec-tl-scroll); intentionally NOT
          user-resizable, so it can never grow into a tall empty void. It still
          publishes the timeline engine the preview + export read, so drag/trim/
          split and word/silence cuts stay consistent (the live app's behaviour). */}
      <div className="ec-legacy timeline-host" style={css(`flex:none;height:${timelineH}px;min-height:0;position:relative;overflow:hidden;border-top:1px solid ${HAIR}`)}>
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
