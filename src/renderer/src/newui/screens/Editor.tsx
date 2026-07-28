import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { css } from '../css'
import { useStore } from '../../store'
import type { LibraryItem } from '@shared/types'
import AutoZoomPanel from './AutoZoomPanel'
import EditPanel from './EditPanel'
import CropModal from './CropModal'
import TranscriptDrawer from './TranscriptDrawer'
import SpeechCleanerPanel from './SpeechCleanerPanel'
import OverlayPanel from '../../components/OverlayPanel'
import SilenceSettingsModal from './SilenceSettingsModal'
import ExportModal from '../../components/ExportModal'
import SettingsModal from '../../components/SettingsModal'
import VideoPreview from '../../components/VideoPreview'
// New-UI fork of the production timeline (newui/timeline/*). Same working code as
// components/timeline/*, but a separate copy we can redesign freely — main's
// timeline is untouched. It owns the shared engine on mount, just like the original.
import TimelinePanel from '../timeline/TimelinePanel'
import { getSharedEngine, useSharedEngineSnapshot } from '../../timelineEngine'
import { addDocTexts, countCaptionTexts } from '../../docTextClips'
import { resolveMedia } from '../../media/resolver'
import { primePlayback } from '../../clock'
import { framesToSeconds } from '@shared/timeline/time'
import { addMediaToTimeline } from '../../timelineAdd'

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
const RAIL = 66 // fixed vertical tool rail beside the (resizable) drawer
const MIN_LEFT = 220 // drawer (design: 258)
const MAX_LEFT = 380
const MIN_RIGHT = 320 // right panel (design: 372)
const MAX_RIGHT = 460
const MIN_PREVIEW = 340 // design stage min-width; keeps preview + transport intact
const HANDLE = 6 // .ec-divv thickness
// Timeline height = this fraction of the editor height, clamped — enough for the
// default lanes, never a tall empty void; extra tracks scroll inside the panel.
const TL_FRACTION = 0.38
const TL_MIN = 240
const TL_MAX = 360

const CLIP9x16 =
  "width:42px;height:74px;flex:none;border-radius:7px;background:repeating-linear-gradient(45deg,#141419 0,#141419 8px,#101015 8px,#101015 16px);display:grid;place-items:center;font-family:'Geist Mono',monospace;font-size:8px;color:#6e6e85"

// Small control glyphs drawn as SVG (not Unicode text) so they sit dead-centre in
// the tiny square buttons — the +/−/list/grid characters never optically centre
// (the fullwidth ＋ especially sits off to one side). They inherit `currentColor`.
const icoStyle = { display: 'block' } as const
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
// "Add all to timeline": two clip rows + a plus. Distinct from IcList (even bars).
const IcAddAll = (): JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={icoStyle}>
    <rect x="2" y="3" width="9" height="2.4" rx="0.9" fill="currentColor" />
    <rect x="2" y="9.6" width="5.5" height="2.4" rx="0.9" fill="currentColor" />
    <path d="M12.4 8.4v4M10.4 10.4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

// Left-dock tab glyphs (flat stroke, 17px) — one per CapCut-style tab.
function TabSvg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={icoStyle}>
      {children}
    </svg>
  )
}
const IcTabMedia = (): JSX.Element => <TabSvg><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none" /></TabSvg>
const IcTabAudio = (): JSX.Element => <TabSvg><circle cx="6.5" cy="17" r="2.6" /><circle cx="17.5" cy="15" r="2.6" /><path d="M9.1 17V6l11-2v11" /></TabSvg>
const IcTabText = (): JSX.Element => <TabSvg><path d="M5 6h14M12 6v13" /></TabSvg>
const IcTabTransition = (): JSX.Element => <TabSvg><path d="M4 8h10m0 0-3-3m3 3-3 3M20 16H10m0 0 3-3m-3 3 3 3" /></TabSvg>
const IcTabCaption = (): JSX.Element => <TabSvg><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M8.5 11.2a2 2 0 1 0 0 2.6M15.5 11.2a2 2 0 1 0 0 2.6" /></TabSvg>
const IcTabSticker = (): JSX.Element => <TabSvg><path d="M12 3l2.4 5 5.6.6-4.2 3.9 1.2 5.5L12 20.6 6.9 18l1.3-5.5L4 8.6 9.6 8z" /></TabSvg>
const IcTabTranscript = (): JSX.Element => <TabSvg><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M8 8h8M8 12h8M8 16h5" /></TabSvg>

// saveState → the design's status dot + label (green Saved / amber Saving / red failed).
const SAVE_UI: Record<string, { c: string; t: string }> = {
  idle: { c: '#7ed6a6', t: 'Saved' },
  saved: { c: '#7ed6a6', t: 'Saved' },
  saving: { c: '#e6b26a', t: 'Saving…' },
  error: { c: '#ff9b9b', t: 'Save failed' }
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
      <div onClick={goHome} style={css('display:flex;align-items:center;gap:7px;font-size:13px;color:#9a9aae;padding:6px 10px;border-radius:8px;cursor:pointer')}>
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
        <div style={css('display:flex;align-items:center;gap:5px;font-size:11.5px;color:#6e6e85')}>
          <div style={css(`width:6px;height:6px;border-radius:50%;background:${sv.c}`)} />{sv.t}
        </div>
      </div>
      <div style={css('flex:1')} />
      <div style={css('display:flex;align-items:center;gap:4px')}>
        <div onClick={() => canUndo && undo()} style={css(`width:30px;height:30px;border-radius:8px;display:grid;place-items:center;font-size:14px;color:${canUndo ? '#9a9aae' : '#4a4a5c'};cursor:${canUndo ? 'pointer' : 'default'}`)}>↶</div>
        <div onClick={() => canRedo && redo()} style={css(`width:30px;height:30px;border-radius:8px;display:grid;place-items:center;font-size:14px;color:${canRedo ? '#9a9aae' : '#4a4a5c'};cursor:${canRedo ? 'pointer' : 'default'}`)}>↷</div>
      </div>
      <div style={css('width:1px;height:20px;background:rgba(255,255,255,.08)')} />
      <button onClick={importMedia} style={css('background:none;border:1px solid rgba(255,255,255,.1);color:#c9c9da;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:9px;padding:7px 13px;cursor:pointer')}>Import</button>
      <div onClick={() => setShowSettings(true)} style={css('width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:#9a9aae;font-size:15px;cursor:pointer')}>···</div>
      <button onClick={() => setShowExportModal(true)} style={css('background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:7px 16px;cursor:pointer')}>Export</button>
    </div>
  )
}

// A clip's preview image. Prefer the probe-generated thumbnail; when that's absent
// (the library is rebuilt from a saved project WITHOUT re-probing, so videos carry
// no thumb) fall back to the clip's OWN first frame via a muted <video> seeked just
// past 0 — the media is already hydrated for the open project, so this is instant
// and needs no extra IPC. Audio / unresolvable clips show the 9:16 placeholder.
function MediaThumb({ item, radius = 0 }: { item: LibraryItem; radius?: number }): JSX.Element {
  const rad = radius ? `;border-radius:${radius}px` : ''
  if (item.thumb)
    return <img src={item.thumb} alt="" draggable={false} style={css(`width:100%;height:100%;object-fit:cover${rad}`)} />
  const url = item.kind === 'audio' ? '' : resolveMedia(item.path).url
  if (url)
    return (
      <video
        src={url}
        muted
        playsInline
        preload="metadata"
        draggable={false}
        onLoadedMetadata={(e) => {
          try {
            e.currentTarget.currentTime = 0.1
          } catch {
            /* seek not ready — the metadata frame still paints */
          }
        }}
        style={css(`width:100%;height:100%;object-fit:cover${rad}`)}
      />
    )
  return <span style={css("font-family:'Geist Mono',monospace;font-size:10px;color:#6e6e85")}>9:16</span>
}

// A library clip. CLICK appends it to the timeline (main/base lane) and DRAG drops
// it onto a specific lane/position — both preserve existing clips. Renders as a
// list row or a grid tile.
function MediaClip({ item, isBase, grid, onRemove, onAdd }: { item: LibraryItem; isBase: boolean; grid?: boolean; onRemove: () => void; onAdd?: () => void }): JSX.Element {
  const onDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.setData('application/x-ec-media', item.id)
    e.dataTransfer.effectAllowed = 'copy'
  }
  const onClick = onAdd ?? ((): void => addMediaToTimeline(item))
  const meta = item.width && item.height ? `${fmtDur(item.duration)} · ${item.width}×${item.height}` : fmtDur(item.duration)

  if (grid) {
    return (
      <div draggable onDragStart={onDragStart} onClick={onClick} title={`${item.name} — click to add, or drag onto the timeline`} style={css(`background:#101015;border:1px solid ${isBase ? 'rgba(124,107,255,.55)' : 'rgba(255,255,255,.07)'};border-radius:11px;overflow:hidden;cursor:grab;${isBase ? 'box-shadow:0 0 0 3px rgba(124,107,255,.12);' : ''}`)}>
        <div style={css('position:relative;aspect-ratio:9/16;max-height:150px;background:#0c0c10;display:grid;place-items:center')}>
          <MediaThumb item={item} />
          <span style={css("position:absolute;right:5px;bottom:5px;font-family:'Geist Mono',monospace;font-size:9px;color:#ededf2;background:rgba(8,8,10,.72);border-radius:5px;padding:2px 5px")}>{fmtDur(item.duration)}</span>
          {isBase && <span style={css('position:absolute;left:5px;top:5px;font-size:9px;font-weight:600;color:#fff;background:rgba(124,107,255,.9);border-radius:5px;padding:2px 6px')}>Base</span>}
        </div>
        <div style={css('display:flex;align-items:center;gap:2px;padding:6px 6px 7px')}>
          <div style={css('flex:1;min-width:0;font-size:11px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')} title={item.name}>{item.name}</div>
          <div onClick={(e) => { e.stopPropagation(); onRemove() }} style={css('color:#9a9aae;font-size:13px;line-height:1;padding:0 3px;cursor:pointer')}>···</div>
        </div>
      </div>
    )
  }

  const shell = isBase
    ? 'background:#101015;border:1px solid rgba(124,107,255,.55);border-radius:12px;padding:10px;display:flex;gap:10px;box-shadow:0 0 0 3px rgba(124,107,255,.12);position:relative;cursor:grab'
    : 'background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:10px;display:flex;gap:10px;cursor:grab'
  return (
    <div draggable onDragStart={onDragStart} onClick={onClick} title={`${item.name} — click to add, or drag onto the timeline`} style={css(shell)}>
      <div style={css(CLIP9x16)}><MediaThumb item={item} radius={7} /></div>
      <div style={css('flex:1;min-width:0;display:flex;flex-direction:column;gap:4px')}>
        <div style={css('font-size:12.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')} title={item.name}>{item.name}</div>
        <div style={css("font-family:'Geist Mono',monospace;font-size:10px;color:#6e6e85")}>{meta}</div>
        {isBase && (
          <div style={css('display:flex;gap:6px;margin-top:2px')}>
            <span style={css('font-size:10px;font-weight:600;color:#a99bff;background:rgba(124,107,255,.18);border-radius:5px;padding:2px 7px')}>Base clip</span>
          </div>
        )}
      </div>
      <div onClick={(e) => { e.stopPropagation(); onRemove() }} style={css('color:#9a9aae;font-size:14px;line-height:1;height:22px;padding:2px 5px;border-radius:6px;cursor:pointer')}>···</div>
    </div>
  )
}

// ---- Left tool rail (66px) + content drawer. The redesign splits the asset dock
// into a vertical tool rail and a drawer whose body depends on the selected tool.
// (The design's "Transcript" tool maps to the right panel's Script cleaner in this
// app — transcript-based cutting already lives there — so it isn't a rail item.)
type LeftTool = 'transcript' | 'media' | 'audio' | 'text' | 'captions' | 'effects' | 'stickers'
const LEFT_TOOLS: { key: LeftTool; label: string; Icon: () => JSX.Element }[] = [
  { key: 'transcript', label: 'Transcript', Icon: IcTabTranscript },
  { key: 'media', label: 'Media', Icon: IcTabMedia },
  { key: 'audio', label: 'Audio', Icon: IcTabAudio },
  { key: 'text', label: 'Text', Icon: IcTabText },
  { key: 'captions', label: 'Captions', Icon: IcTabCaption },
  { key: 'effects', label: 'Effects', Icon: IcTabTransition },
  { key: 'stickers', label: 'Stickers', Icon: IcTabSticker }
]

function ToolRail({ tool, setTool }: { tool: LeftTool; setTool: (t: LeftTool) => void }): JSX.Element {
  return (
    <div style={css(`width:66px;flex:none;border-right:1px solid ${HAIR};background:#0c0c10;display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 0`)}>
      {LEFT_TOOLS.map(({ key, label, Icon }) => {
        const on = key === tool
        return (
          <button key={key} onClick={() => setTool(key)} title={label} style={css(`flex:none;width:54px;display:flex;flex-direction:column;align-items:center;gap:5px;padding:9px 0;border:none;border-radius:9px;cursor:pointer;font-family:inherit;appearance:none;-webkit-appearance:none;background:${on ? 'rgba(124,107,255,.15)' : 'transparent'};color:${on ? '#c4baff' : '#8b8ba0'}`)}>
            <Icon />
            <span style={css('font-size:10px;font-weight:500')}>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

function Drawer({ tool, width }: { tool: LeftTool; width: number }): JSX.Element {
  return (
    <div style={css(`width:${width}px;flex:none;min-width:0;display:flex;flex-direction:column;background:#0a0a0d;overflow:hidden`)}>
      {tool === 'media' && <MediaTab />}
      {tool === 'audio' && <AudioTab />}
      {tool === 'text' && <TextTab />}
      {tool === 'captions' && <CaptionsTab />}
      {tool === 'effects' && <ComingSoon title="Effects" note="Crossfades, clip transitions and video effects are coming soon." Icon={IcTabTransition} />}
      {tool === 'stickers' && <StickersTab />}
    </div>
  )
}

function MediaTab(): JSX.Element {
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
    <>
      <div style={css('padding:12px 16px 0;display:flex;flex-direction:column;gap:8px')}>
        <div style={css('display:flex;gap:8px')}>
          <button onClick={addToLibrary} style={css('flex:1;background:rgba(124,107,255,.14);border:1px solid rgba(124,107,255,.3);color:#a99bff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:8px 0;cursor:pointer')}>＋ Import media</button>
          {canSequence && (
            <button onClick={addAllToTimeline} title="Add all to timeline — every video/image as one sequence, in order" aria-label="Add all to timeline" style={css('flex:none;width:38px;display:grid;place-items:center;background:none;border:1px solid rgba(255,255,255,.12);color:#c9c9da;border-radius:9px;padding:0;cursor:pointer;appearance:none;-webkit-appearance:none')}><IcAddAll /></button>
          )}
        </div>
        <div style={css('display:flex;gap:8px;align-items:stretch')}>
          <div style={css('flex:1;display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;background:#101015;border:1px solid rgba(255,255,255,.06);border-radius:8px')}>
            <div style={css('width:10px;height:10px;border:1.5px solid #6e6e85;border-radius:50%;position:relative')}>
              <div style={css('position:absolute;width:4px;height:1.5px;background:#6e6e85;bottom:-2px;right:-2px;transform:rotate(45deg)')} />
            </div>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter media" style={css('font-size:12px;color:#ededf2;flex:1;min-width:0;background:none;border:none;outline:none;font-family:inherit;padding:0;margin:0')} />
          </div>
          <div style={css('display:flex;gap:2px;background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:7px;padding:2px;flex:none')}>
            <button onClick={() => setView('list')} title="List view" style={css(`width:24px;border:none;border-radius:5px;cursor:pointer;padding:0;appearance:none;-webkit-appearance:none;display:grid;place-items:center;background:${view === 'list' ? 'rgba(124,107,255,.25)' : 'transparent'};color:${view === 'list' ? '#a99bff' : '#9a9aae'}`)}><IcList /></button>
            <button onClick={() => setView('grid')} title="Grid view" style={css(`width:24px;border:none;border-radius:5px;cursor:pointer;padding:0;appearance:none;-webkit-appearance:none;display:grid;place-items:center;background:${view === 'grid' ? 'rgba(124,107,255,.25)' : 'transparent'};color:${view === 'grid' ? '#a99bff' : '#9a9aae'}`)}><IcGrid /></button>
          </div>
        </div>
      </div>
      <div style={css('flex:1;min-height:0;padding:10px 12px 12px;overflow-y:auto')}>
        {items.length === 0 ? (
          <div style={css('color:#6e6e85;font-size:12px;text-align:center;padding:24px 8px')}>{library.length === 0 ? 'No media yet — tap ＋ Import media to add clips.' : 'No clips match your filter.'}</div>
        ) : view === 'grid' ? (
          <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:8px')}>
            {items.map((it) => (<MediaClip key={it.id} item={it} grid isBase={!!basePath && it.path === basePath} onRemove={() => removeFromLibrary(it.id)} />))}
          </div>
        ) : (
          <div style={css('display:flex;flex-direction:column;gap:8px')}>
            {items.map((it) => (<MediaClip key={it.id} item={it} isBase={!!basePath && it.path === basePath} onRemove={() => removeFromLibrary(it.id)} />))}
          </div>
        )}
      </div>
      <div style={css('flex:none;padding:12px 16px;font-size:11px;line-height:1.5;color:#6e6e85;border-top:1px solid rgba(255,255,255,.05)')}>Drag a clip onto the timeline, or click to add it.</div>
    </>
  )
}

function AudioTab(): JSX.Element {
  const library = useStore((s) => s.library)
  const basePath = useStore((s) => s.project.media?.path)
  const addToLibrary = useStore((s) => s.addAudioToLibrary)
  const removeFromLibrary = useStore((s) => s.removeFromLibrary)
  const audio = library.filter((it) => it.kind === 'audio')
  return (
    <>
      <div style={css('padding:12px 16px 0')}>
        <button onClick={addToLibrary} style={css('width:100%;background:rgba(124,107,255,.14);border:1px solid rgba(124,107,255,.3);color:#a99bff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 0;cursor:pointer')}>＋ Import audio</button>
      </div>
      <div style={css('flex:1;min-height:0;padding:10px 12px 12px;overflow-y:auto')}>
        {audio.length === 0 ? (
          <div style={css('color:#6e6e85;font-size:12px;text-align:center;padding:24px 8px;line-height:1.6')}>No audio yet. Import a music or voiceover file — it drops onto an audio track.</div>
        ) : (
          <div style={css('display:flex;flex-direction:column;gap:8px')}>
            {audio.map((it) => (<MediaClip key={it.id} item={it} isBase={!!basePath && it.path === basePath} onRemove={() => removeFromLibrary(it.id)} />))}
          </div>
        )}
      </div>
      <div style={css('flex:none;padding:12px 16px;font-size:11px;line-height:1.5;color:#6e6e85;border-top:1px solid rgba(255,255,255,.05)')}>Click an audio clip to add it on an audio track at the playhead.</div>
    </>
  )
}

function TextTab(): JSX.Element {
  const playhead = useStore((s) => s.project.playhead)
  // Add a real timeline text clip at the playhead and select it — the Edit tab
  // (auto-opens on selection) is where its full style controls live.
  const add = (): void => void addDocTexts([{ text: 'Your text', startS: playhead, endS: playhead + 3 }], true)
  return (
    <div style={css('flex:1;min-height:0;overflow-y:auto;padding:14px 16px')}>
      <button onClick={add} style={css('width:100%;display:flex;align-items:center;justify-content:center;gap:7px;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;cursor:pointer;box-shadow:0 6px 18px rgba(124,107,255,.3)')}>＋ Add text</button>
      <div style={css('margin-top:16px;color:#6e6e85;font-size:12px;line-height:1.6;text-align:center')}>Adds a text layer at the playhead and opens it in the Edit tab. Drag it on the preview to position, or restyle it there.</div>
    </div>
  )
}

function StickersTab(): JSX.Element {
  const library = useStore((s) => s.library)
  const addToLibrary = useStore((s) => s.addToLibrary)
  const removeFromLibrary = useStore((s) => s.removeFromLibrary)
  const addLibraryToOverlay = useStore((s) => s.addLibraryToOverlay)
  const images = library.filter((it) => it.kind === 'image')
  return (
    <>
      <div style={css('padding:12px 16px 0')}>
        <button onClick={addToLibrary} style={css('width:100%;background:rgba(124,107,255,.14);border:1px solid rgba(124,107,255,.3);color:#a99bff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 0;cursor:pointer')}>＋ Import image</button>
      </div>
      <div style={css('flex:1;min-height:0;padding:10px 12px 12px;overflow-y:auto')}>
        {images.length === 0 ? (
          <div style={css('color:#6e6e85;font-size:12px;text-align:center;padding:24px 8px;line-height:1.6')}>No stickers yet. Import a PNG, logo or graphic — click it to drop it on an overlay track.</div>
        ) : (
          <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:8px')}>
            {images.map((it) => (<MediaClip key={it.id} item={it} grid isBase={false} onAdd={() => addLibraryToOverlay(it.id)} onRemove={() => removeFromLibrary(it.id)} />))}
          </div>
        )}
      </div>
      <div style={css('flex:none;padding:12px 16px;font-size:11px;line-height:1.5;color:#6e6e85;border-top:1px solid rgba(255,255,255,.05)')}>Click a graphic to add it as an overlay at the playhead.</div>
    </>
  )
}

function CaptionsTab(): JSX.Element {
  const generateCaptions = useStore((s) => s.generateCaptions)
  const clearCaptions = useStore((s) => s.clearCaptions)
  const hasTranscript = useStore((s) => !!s.project.transcript?.words?.length)
  const snap = useSharedEngineSnapshot()
  const capCount = countCaptionTexts(snap?.doc)
  const jobActive = useStore((s) => s.job.active)
  return (
    <div style={css('flex:1;min-height:0;overflow-y:auto;padding:14px 16px')}>
      <div style={css('font-size:10px;font-weight:700;letter-spacing:.08em;color:#6e6e85;text-transform:uppercase;margin-bottom:10px')}>Auto captions</div>
      <button onClick={() => void generateCaptions()} disabled={jobActive} style={css(`width:100%;display:flex;align-items:center;justify-content:center;gap:7px;background:#7c6bff;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:11px 0;box-shadow:0 6px 18px rgba(124,107,255,.3);opacity:${jobActive ? 0.6 : 1};cursor:${jobActive ? 'default' : 'pointer'}`)}>Generate captions</button>
      {capCount > 0 && (
        <div style={css('margin-top:10px;display:flex;align-items:center;gap:8px')}>
          <div style={css('flex:1;font-size:12px;color:#9fdfbe')}>{capCount} caption line{capCount === 1 ? '' : 's'} on the timeline</div>
          <button onClick={clearCaptions} style={css('flex:none;background:none;border:1px solid rgba(255,255,255,.12);color:#c9c9da;font-family:inherit;font-size:12px;border-radius:8px;padding:6px 12px;cursor:pointer')}>Clear</button>
        </div>
      )}
      <div style={css('margin-top:16px;font-size:11.5px;color:#6e6e85;line-height:1.6')}>{hasTranscript ? 'Turns your transcript into subtitle clips on a text track. Click any line to restyle it in the Edit tab.' : 'Run Find Retakes & Silence (or Transcribe) first to get a transcript, then generate captions.'}</div>
    </div>
  )
}

function ComingSoon({ title, note, Icon }: { title: string; note: string; Icon: () => JSX.Element }): JSX.Element {
  return (
    <div style={css('flex:1;min-height:0;display:grid;place-items:center;padding:24px;text-align:center')}>
      <div>
        <div style={css('width:44px;height:44px;border-radius:12px;background:#101015;display:grid;place-items:center;margin:0 auto 12px;color:#6e6e85')}><Icon /></div>
        <div style={css('font-size:13px;font-weight:600;color:#c9c9da')}>{title}</div>
        <div style={css('font-size:12px;color:#6e6e85;line-height:1.6;margin-top:6px;max-width:200px')}>{note}</div>
      </div>
    </div>
  )
}

// Right panel — the redesign's two top-level tabs. "AI tools" holds an inner
// sub-nav over the three AI workflows (Script cleaner = retake/AI-cut, Auto zoom,
// Auto b-roll = overlays); "Edit" is the clip/text/overlay inspector. Each panel
// is the same wired component as before — only the container/nav changed.
const PANEL_TABS = ['AI tools', 'Edit'] as const
type AiSub = 'script' | 'zoom' | 'overlay'
const AI_SUB: { id: AiSub; label: string }[] = [
  { id: 'script', label: 'Speech cleaner' },
  { id: 'zoom', label: 'Auto zoom' },
  { id: 'overlay', label: 'Auto b-roll' }
]

function RightPanel({ width }: { width: number }): JSX.Element {
  const [tab, setTab] = useState<0 | 1>(0) // 0 = AI tools, 1 = Edit
  const [ai, setAi] = useState<AiSub>('script')
  const cutCount = useStore((s) => s.selectedWordIds.size) // live "Speech cleaner" badge
  // Jump to Edit when a clip / text / overlay is selected (inspector behaviour).
  // Only fires on a *new* engine selection — clicking transcript words never
  // yanks you out of the AI tools.
  const snap = useSharedEngineSnapshot()
  const selId = snap?.interaction.selection[0] ?? null
  const prevSel = useRef<string | null>(selId)
  useEffect(() => {
    if (selId && selId !== prevSel.current) setTab(1)
    prevSel.current = selId
  }, [selId])
  return (
    <div style={css(`width:${width}px;flex:none;min-width:0;display:flex;flex-direction:column;background:#0c0c10;overflow:hidden`)}>
      <div style={css(`display:flex;gap:6px;padding:12px 14px;border-bottom:1px solid ${HAIR};flex:none`)}>
        {PANEL_TABS.map((label, i) => (
          <div key={label} onClick={() => setTab(i as 0 | 1)} style={css('flex:1;text-align:center;font-size:12.5px;padding:8px 11px;border-radius:8px;cursor:pointer;white-space:nowrap', tab === i ? 'background:rgba(124,107,255,.16);color:#c4baff;font-weight:600' : 'color:#8b8ba0')}>{label}</div>
        ))}
      </div>
      {tab === 0 ? (
        <div style={css('flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden')}>
          <div style={css('flex:none;padding:10px 12px 8px;display:flex;flex-direction:column;gap:1px')}>
            {AI_SUB.map((a) => {
              const on = ai === a.id
              const badge = a.id === 'script' && cutCount > 0 ? String(cutCount) : ''
              return (
                <div key={a.id} onClick={() => setAi(a.id)} style={css('display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer;transition:background .15s', on ? 'background:rgba(124,107,255,.12)' : '')}>
                  <span style={css(`width:6px;height:6px;border-radius:50%;flex:none;background:${on ? '#a99bff' : '#4a4a5c'}`)} />
                  <span style={css(`flex:1;font-size:12px;letter-spacing:-.01em;color:${on ? '#ededf2' : '#9a9aae'};${on ? 'font-weight:600' : ''}`)}>{a.label}</span>
                  {badge && <span style={css(`font-family:'Geist Mono',monospace;font-size:10px;color:${on ? '#a99bff' : '#5c5c70'}`)}>{badge}</span>}
                </div>
              )
            })}
          </div>
          <div style={css(`flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-top:1px solid ${HAIR}`)}>
            {ai === 'script' ? (
              <SpeechCleanerPanel />
            ) : ai === 'zoom' ? (
              <AutoZoomPanel />
            ) : (
              <div style={css('flex:1;min-height:0;overflow:auto;padding:12px')}>
                <OverlayPanel />
              </div>
            )}
          </div>
        </div>
      ) : (
        <EditPanel />
      )}
    </div>
  )
}


export default function Editor(): JSX.Element {
  const showExportModal = useStore((s) => s.showExportModal)
  const showSettings = useStore((s) => s.showSettings)
  const showCropModal = useStore((s) => s.showCropModal)
  const pendingCaptions = useStore((s) => s.pendingCaptions)
  const pendingAutoZoom = useStore((s) => s.pendingAutoZoom)

  // Captions requested in the New Project wizard run HERE, once the timeline
  // engine has mounted the document (captions write doc text clips, which need
  // the live engine). Poll a few seconds for the doc + a transcript, then fire.
  useEffect(() => {
    if (!pendingCaptions) return
    let handle = 0
    let tries = 0
    const tick = (): void => {
      const doc = getSharedEngine()?.document
      const ready = !!doc && doc.tracks.some((t) => t.isMain && t.clips.length > 0)
      const hasTranscript = (useStore.getState().project.transcript?.words?.length ?? 0) > 0
      if (ready && hasTranscript) {
        useStore.getState().generateCaptions()
        useStore.getState().clearPendingCaptions()
        return
      }
      if (tries++ > 300) {
        // Give up quietly (no transcript / no clips) rather than poll forever.
        useStore.getState().clearPendingCaptions()
        return
      }
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [pendingCaptions])

  // Auto Zoom requested in the New Project wizard runs HERE too, once the timeline
  // engine has mounted the (already-cut) document and a transcript exists — Auto
  // Zoom reads the main-lane clips + transcript and writes per-clip zoom metadata.
  useEffect(() => {
    if (!pendingAutoZoom) return
    let handle = 0
    let tries = 0
    const tick = (): void => {
      const doc = getSharedEngine()?.document
      const ready = !!doc && doc.tracks.some((t) => t.isMain && t.clips.length > 0)
      const hasTranscript = (useStore.getState().project.transcript?.words?.length ?? 0) > 0
      if (ready && hasTranscript) {
        void useStore.getState().runAutoZoom()
        useStore.getState().clearPendingAutoZoom()
        return
      }
      if (tries++ > 300) {
        useStore.getState().clearPendingAutoZoom()
        return
      }
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [pendingAutoZoom])

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
  const [leftW, setLeftW] = useState(() => num('ec.nu.leftW', 258))
  const [rightW, setRightW] = useState(() => num('ec.nu.rightW', 372))
  const [timelineH, setTimelineH] = useState(TL_MIN)
  const [tool, setTool] = useState<LeftTool>('transcript')
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
    return Math.max(MIN_LEFT, Math.min(MAX_LEFT, midW - RAIL - 2 * HANDLE - rightPx - MIN_PREVIEW))
  }
  const maxRightPx = (leftPx: number): number => {
    const midW = middleRef.current?.clientWidth ?? window.innerWidth
    return Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, midW - RAIL - 2 * HANDLE - leftPx - MIN_PREVIEW))
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
    let over = L + R + RAIL + 2 * HANDLE + MIN_PREVIEW - midW
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
    <div ref={rootRef} style={css('width:100%;height:100%;background:#08080a;display:flex;flex-direction:column;overflow:hidden')} className="ec-newui ec-editor">
      <TopBar />
      <div ref={middleRef} style={css('display:flex;flex:1;min-height:0;min-width:0')}>
        <ToolRail tool={tool} setTool={setTool} />
        {tool === 'transcript' ? <TranscriptDrawer width={leftW} /> : <Drawer tool={tool} width={leftW} />}
        <div className="ec-divv" onPointerDown={(e) => startColDrag(e, 'left')} title="Drag to resize" />
        {/* Live editor core — the production preview. `.ec-legacy` restores the
            app's border-box model (the .ec-newui content-box reset would leak in
            and break the legacy layout). It reads the SAME shared timeline engine
            the timeline below publishes, so playback reflects the real edit. */}
        <div className="ec-legacy" style={css('flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:#08080a')}>
          <VideoPreview />
        </div>
        <div className="ec-divv" onPointerDown={(e) => startColDrag(e, 'right')} title="Drag to resize" />
        <RightPanel width={rightW} />
      </div>
      {/* Timeline. The production TimelinePanel is kept mounted UNDERNEATH because
          it OWNS the shared timeline engine (setSharedEngine on mount) that the
          preview, cuts and export all read — unmounting it would null the engine
          and break everything. The redesign's ReviewTimeline is layered opaque on
          top as the VISIBLE timeline (its own new-UI component; the shared
          TimelinePanel is untouched). TimelinePanel's keyboard editing (split S /
          delete / frame-step) still works since it stays mounted. */}
      <div className="ec-legacy ec-nu-tl timeline-host" style={css(`flex:none;height:${timelineH}px;min-height:0;position:relative;overflow:hidden;border-top:1px solid ${HAIR}`)}>
        <TimelinePanel />
      </div>
      <SilenceSettingsModal />
      {/* Legacy modals assume the app's global border-box — portal them out of
          the .ec-newui (content-box) subtree so they render correctly. */}
      {showExportModal && createPortal(<ExportModal />, document.body)}
      {showSettings && createPortal(<SettingsModal />, document.body)}
      {showCropModal && createPortal(<CropModal />, document.body)}
    </div>
  )
}
