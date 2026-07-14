import { useState } from 'react'
import { css } from '../css'
import { useStore } from '../../store'
import type { LibraryItem } from '@shared/types'
import RetakeCleanerPanel from './RetakeCleanerPanel'
import SilenceSettingsModal from './SilenceSettingsModal'

function fmtDur(s: number): string {
  if (!s || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

// Screen 1b — Video editor (1440 · AI Cut tab, results-ready / reviewing state).
// Verbatim port of the approved design. Fluid: fills width/height; media panel
// (264) and AI panel (360) are fixed rails, preview flexes, timeline is a fixed
// 236 strip (design responsive rule: three-panel at ≥1440).

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

function MediaPanel(): JSX.Element {
  const library = useStore((s) => s.library)
  const basePath = useStore((s) => s.project.media?.path)
  const addToLibrary = useStore((s) => s.addToLibrary)
  const setBaseFromLibrary = useStore((s) => s.setBaseFromLibrary)
  const removeFromLibrary = useStore((s) => s.removeFromLibrary)
  const [filter, setFilter] = useState('')

  const q = filter.trim().toLowerCase()
  const items = q ? library.filter((it) => it.name.toLowerCase().includes(q)) : library

  return (
    <div style={css(`width:264px;flex:none;border-right:1px solid ${HAIR};display:flex;flex-direction:column;background:#191B20`)}>
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

function PreviewStage(): JSX.Element {
  return (
    <div style={css('flex:1;min-width:0;display:flex;flex-direction:column;background:#141519')}>
      <div style={css('flex:1;display:grid;place-items:center;padding:28px')}>
        <div style={css("height:100%;max-height:560px;aspect-ratio:9/16;border-radius:12px;background:repeating-linear-gradient(45deg,#1d1f25 0,#1d1f25 14px,#191b20 14px,#191b20 28px);border:1px solid rgba(255,255,255,.06);display:grid;place-items:center;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#686E7B")}>video preview</div>
      </div>
      <div style={css('flex:none;display:flex;align-items:center;gap:16px;padding:0 20px 18px')}>
        <div style={css('display:flex;gap:2px;background:#1E2026;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:3px')}>
          <span style={css('font-size:11.5px;color:#9BA0AC;padding:5px 10px;border-radius:7px;cursor:pointer')}>Source</span>
          <span style={css('font-size:11.5px;color:#E9EAEE;background:#2E3140;border-radius:7px;padding:5px 10px;font-weight:550')}>9:16</span>
          <span style={css('font-size:11.5px;color:#9BA0AC;padding:5px 10px;border-radius:7px;cursor:pointer')}>16:9</span>
          <span style={css('font-size:11.5px;color:#9BA0AC;padding:5px 10px;border-radius:7px;cursor:pointer')}>1:1</span>
          <span style={css('font-size:11.5px;color:#9BA0AC;padding:5px 10px;border-radius:7px;cursor:pointer')}>4:5</span>
        </div>
        <div style={css('flex:1')} />
        <div style={css('display:flex;align-items:center;gap:6px')}>
          <div style={css('width:32px;height:32px;border-radius:9px;display:grid;place-items:center;color:#9BA0AC;cursor:pointer')}>
            <div style={css('display:flex;gap:1px')}>
              <div style={css('width:2px;height:9px;background:currentColor')} />
              <div style={css('width:0;height:0;border-right:7px solid currentColor;border-top:5px solid transparent;border-bottom:5px solid transparent')} />
            </div>
          </div>
          <div style={css('width:38px;height:38px;border-radius:50%;background:#E9EAEE;display:grid;place-items:center;cursor:pointer')}>
            <div style={css('width:0;height:0;border-left:11px solid #17181C;border-top:7px solid transparent;border-bottom:7px solid transparent;margin-left:2px')} />
          </div>
          <div style={css('width:32px;height:32px;border-radius:9px;display:grid;place-items:center;color:#9BA0AC;cursor:pointer')}>
            <div style={css('display:flex;gap:1px')}>
              <div style={css('width:0;height:0;border-left:7px solid currentColor;border-top:5px solid transparent;border-bottom:5px solid transparent')} />
              <div style={css('width:2px;height:9px;background:currentColor')} />
            </div>
          </div>
        </div>
        <div style={css('flex:1')} />
        <div style={css("font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#9BA0AC")}>
          <span style={css('color:#E9EAEE')}>00:41.2</span> / 03:28.0
        </div>
      </div>
    </div>
  )
}

// Only the AI Cut tab has approved design content. The others (Edit/Text/
// Overlays/Audio) are wired for active-state + selection but their panels await
// design (and the "Audio" ↔ silence/ost mapping decision), so they show an
// honest placeholder rather than mounting off-design legacy panels.
const AI_TABS = ['AI Cut', 'Edit', 'Text', 'Overlays', 'Audio'] as const

function AiPanel(): JSX.Element {
  const [tab, setTab] = useState<(typeof AI_TABS)[number]>('AI Cut')
  return (
    <div style={css(`width:360px;flex:none;border-left:1px solid ${HAIR};display:flex;flex-direction:column;background:#191B20`)}>
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

function fmtTC(t: number, fps = 30): string {
  const tt = Math.max(0, t)
  const h = Math.floor(tt / 3600)
  const m = Math.floor((tt % 3600) / 60)
  const s = Math.floor(tt % 60)
  const f = Math.floor((tt % 1) * fps)
  return [h, m, s, f].map((n) => String(n).padStart(2, '0')).join(':')
}
function fmtMS(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function Timeline(): JSX.Element {
  const magnet = useStore((s) => s.project.magnet)
  const toggleMagnet = useStore((s) => s.toggleMagnet)
  const splitAtPlayhead = useStore((s) => s.splitAtPlayhead)
  const splitBaseAtPlayhead = useStore((s) => s.splitBaseAtPlayhead)
  const pxPerSec = useStore((s) => s.project.pxPerSec)
  const setZoom = useStore((s) => s.setZoom)
  const playhead = useStore((s) => s.project.playhead)
  const media = useStore((s) => s.project.media)
  const transcript = useStore((s) => s.project.transcript)
  const selected = useStore((s) => s.selectedWordIds)
  const projSilences = useStore((s) => s.project.silences)
  const staged = useStore((s) => s.stagedSilences)
  const stagedSel = useStore((s) => s.stagedSilenceSel)
  const smartSilence = useStore((s) => s.smartSilenceCutter)

  const duration = media?.duration || (transcript?.words.length ? transcript.words[transcript.words.length - 1].end : 0) || 1
  const clipName = media?.path ? media.path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '') : 'Base'
  const pct = (t: number): number => Math.max(0, Math.min(100, (t / duration) * 100))
  const zoomFrac = Math.max(0, Math.min(1, (pxPerSec - 10) / (300 - 10))) * 100

  // Proposed word cuts → red bands; enabled silences → amber bands (real data).
  const wById = new Map((transcript?.words ?? []).map((w) => [w.id, w]))
  const cutBands = [...selected].map((id) => wById.get(id)).filter(Boolean).map((w) => ({ l: pct(w!.start), wd: Math.max(0.4, pct(w!.end - w!.start)) }))
  const silBands = [...(smartSilence ? staged.filter((r) => stagedSel.has(r.id)) : []), ...projSilences].map((r) => ({ l: pct(r.start), wd: Math.max(0.4, pct(r.end - r.start)) }))
  const cell = 'width:16.66%;padding-left:8px'
  const playLeft = `${1.5 + (Math.max(0, Math.min(duration, playhead)) / duration) * 96.5}%`

  return (
    <div style={css(`flex:none;height:236px;border-top:1px solid ${HAIR};background:#191B20;display:flex;flex-direction:column`)}>
      <div style={css('display:flex;align-items:center;gap:8px;height:38px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.05)')}>
        <span onClick={toggleMagnet} style={css(magnet ? 'font-size:11.5px;color:#B7B5F4;background:rgba(110,106,232,.14);border:1px solid rgba(110,106,232,.28);border-radius:7px;padding:4px 10px;font-weight:550;cursor:pointer' : 'font-size:11.5px;color:#9BA0AC;border:1px solid transparent;border-radius:7px;padding:4px 10px;font-weight:550;cursor:pointer')}>Snap</span>
        <span style={css('font-size:11.5px;color:#9BA0AC;padding:4px 10px;border-radius:7px;cursor:pointer')}>＋ Track</span>
        <span onClick={() => { splitAtPlayhead() || splitBaseAtPlayhead() }} style={css('font-size:11.5px;color:#9BA0AC;padding:4px 10px;border-radius:7px;cursor:pointer')}>Split</span>
        <span style={css('font-size:11.5px;color:#9BA0AC;padding:4px 10px;border-radius:7px;cursor:pointer')}>Detach audio</span>
        <div style={css('flex:1')} />
        <div style={css("font-family:'IBM Plex Mono',monospace;font-size:11px;color:#9BA0AC")}>{fmtTC(playhead)}</div>
        <div style={css('display:flex;align-items:center;gap:8px;margin-left:8px')}>
          <span style={css('font-size:12px;color:#686E7B')}>−</span>
          <div style={css('width:90px;height:3px;border-radius:2px;background:#2A2D36;position:relative')}>
            <div style={css(`width:${zoomFrac}%;height:100%;border-radius:2px;background:#686E7B`)} />
            <div style={css(`position:absolute;left:${zoomFrac}%;top:50%;transform:translate(-50%,-50%);width:11px;height:11px;border-radius:50%;background:#C6C9D2`)} />
            <input type="range" min={10} max={300} value={pxPerSec} onChange={(e) => setZoom(Number(e.target.value))} style={css('position:absolute;left:0;right:0;top:-8px;bottom:-8px;width:100%;height:auto;margin:0;opacity:0;cursor:pointer')} />
          </div>
          <span style={css('font-size:12px;color:#686E7B')}>＋</span>
        </div>
      </div>
      <div style={css('flex:1;display:flex;min-height:0;position:relative')}>
        {/* track headers */}
        <div style={css(`width:148px;flex:none;border-right:1px solid ${HAIR};display:flex;flex-direction:column;font-size:11.5px`)}>
          <div style={css('height:26px;flex:none;border-bottom:1px solid rgba(255,255,255,.04)')} />
          <div style={css('height:26px;display:flex;align-items:center;gap:7px;padding:0 10px;color:#9BA0AC;border-bottom:1px solid rgba(255,255,255,.04)')}><span style={css('font-size:9px;color:#686E7B')}>▸</span>Text<div style={css('flex:1')} /><span style={css('color:#4A4F5B;font-size:10px')}>◦ ◦</span></div>
          <div style={css('height:26px;display:flex;align-items:center;gap:7px;padding:0 10px;color:#9BA0AC;border-bottom:1px solid rgba(255,255,255,.04)')}><span style={css('font-size:9px;color:#686E7B')}>▸</span>Overlays<div style={css('flex:1')} /><span style={css('color:#4A4F5B;font-size:10px')}>◦ ◦</span></div>
          <div style={css('flex:1;display:flex;align-items:center;gap:7px;padding:0 10px;color:#E9EAEE;font-weight:550;border-bottom:1px solid rgba(255,255,255,.04)')}>Video<div style={css('flex:1')} /><span style={css('color:#4A4F5B;font-size:10px')}>◦ ◦</span></div>
          <div style={css('height:34px;display:flex;align-items:center;gap:7px;padding:0 10px;color:#9BA0AC')}>Audio<div style={css('flex:1')} /><span style={css('color:#4A4F5B;font-size:10px')}>◦ ◦</span></div>
        </div>
        {/* lanes */}
        <div style={css('flex:1;position:relative;overflow:hidden')}>
          {/* ruler (derived from duration) */}
          <div style={css("height:26px;display:flex;align-items:center;border-bottom:1px solid rgba(255,255,255,.05);font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:#565C68")}>
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} style={css(cell)}>{fmtMS((duration * i) / 6)}</div>)}
          </div>
          {/* text + overlay lanes — illustrative (not yet data-driven; flagged) */}
          <div style={css('height:26px;border-bottom:1px solid rgba(255,255,255,.04);position:relative')}><div style={css('position:absolute;left:22%;width:14%;top:5px;bottom:5px;border-radius:5px;background:rgba(91,155,217,.22);border:1px solid rgba(91,155,217,.4)')} /></div>
          <div style={css('height:26px;border-bottom:1px solid rgba(255,255,255,.04);position:relative')}><div style={css('position:absolute;left:48%;width:9%;top:5px;bottom:5px;border-radius:5px;background:rgba(91,155,217,.14);border:1px solid rgba(91,155,217,.3)')} /></div>
          {/* video lane */}
          <div style={css('position:absolute;top:78px;bottom:34px;left:0;right:0;border-bottom:1px solid rgba(255,255,255,.04)')}>
            <div style={css('position:absolute;left:1.5%;right:2%;top:8px;bottom:8px;border-radius:9px;overflow:hidden;background:repeating-linear-gradient(90deg,#2b2e37 0,#2b2e37 34px,#24262e 34px,#24262e 68px);border:1px solid rgba(255,255,255,.12)')}>
              <div style={css('position:absolute;left:0;top:0;bottom:0;width:6px;background:rgba(110,106,232,.9);border-radius:9px 0 0 9px')} />
              <div style={css('position:absolute;right:0;top:0;bottom:0;width:6px;background:rgba(110,106,232,.9);border-radius:0 9px 9px 0')} />
              <div style={css('position:absolute;left:10px;top:6px;font-size:10.5px;font-weight:550;color:#C6C9D2')}>{clipName}</div>
              {cutBands.map((b, i) => <div key={'c' + i} style={css(`position:absolute;left:${b.l}%;width:${b.wd}%;top:0;bottom:0;background:rgba(217,104,110,.28);border-left:1px solid rgba(217,104,110,.8);border-right:1px solid rgba(217,104,110,.8)`)} />)}
              {silBands.map((b, i) => <div key={'s' + i} style={css(`position:absolute;left:${b.l}%;width:${b.wd}%;top:0;bottom:0;background:rgba(217,164,74,.24)`)} />)}
            </div>
          </div>
          {/* audio lane — illustrative waveform (flagged) */}
          <div style={css('position:absolute;bottom:0;height:34px;left:0;right:0')}>
            <div style={css('position:absolute;left:1.5%;right:2%;top:5px;bottom:5px;border-radius:6px;background:rgba(70,165,124,.1);border:1px solid rgba(70,165,124,.22);overflow:hidden')}>
              <div style={css('position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(70,165,124,.4) 0,rgba(70,165,124,.4) 2px,transparent 2px,transparent 5px);-webkit-mask-image:linear-gradient(0deg,transparent 10%,#000 30%,#000 70%,transparent 90%)')} />
            </div>
          </div>
          {/* playhead (real position) */}
          <div style={css(`position:absolute;left:${playLeft};top:0;bottom:0;width:1.5px;background:#E9EAEE;z-index:4`)}><div style={css('position:absolute;top:0;left:50%;transform:translateX(-50%);width:11px;height:14px;background:#E9EAEE;border-radius:3px 3px 6px 6px')} /></div>
        </div>
      </div>
    </div>
  )
}

export default function Editor(): JSX.Element {
  return (
    <div style={css('width:100%;height:100%;background:#17181C;display:flex;flex-direction:column')} className="ec-newui ec-editor">
      <TopBar />
      <div style={css('display:flex;flex:1;min-height:0')}>
        <MediaPanel />
        <PreviewStage />
        <AiPanel />
      </div>
      <Timeline />
      <SilenceSettingsModal />
    </div>
  )
}
