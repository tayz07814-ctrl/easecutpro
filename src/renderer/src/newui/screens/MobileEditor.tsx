import { useState, useEffect, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { css } from '../css'
import { useStore } from '../../store'
import type { LibraryItem } from '@shared/types'
import VideoPreview from '../../components/VideoPreview'
import TimelinePanel from '../../components/timeline/TimelinePanel'
import { MobileTools } from '../../components/mobile/MobileTools'
import { Icon } from '../../components/mobile/Icon'
import MobileTextPanel from '../../components/mobile/MobileTextPanel'
import RetakeCleanerPanel from './RetakeCleanerPanel'
import SilenceSettingsModal from './SilenceSettingsModal'
import MobileExportDrawer from '../../components/mobile/MobileExportDrawer'
import SettingsModal from '../../components/SettingsModal'
import { getSharedEngine, useSharedEngineSnapshot } from '../../timelineEngine'
import { primePlayback } from '../../clock'
import { addMediaToTimeline } from '../../timelineAdd'
import { countCaptionTexts } from '../../docTextClips'
import { loadStoredFonts } from '../../customFonts'
import { CAPTION_STYLES, DEFAULT_CAPTION_STYLE } from '../../captionStyles'

// Mobile layout for the new UI editor. Same chassis the proven legacy MobileApp
// uses — a FIXED, user-resizable stage (so the timeline never drifts), the
// production preview + mobile timeline (the shared engine), and the CapCut-style
// MobileTools dock (Import + Cut Lord, contextual tools when a clip is selected).
// Cut Lord / Silence Settings are the NEW-UI panels. Portrait-first.

const HAIR = 'rgba(255,255,255,.06)'
const ZOOM_MIN = 4
const ZOOM_MAX = 2000

type SheetKind = 'cut' | 'media' | 'text' | 'music' | 'captions' | null

function Sheet({ onClose, children, header }: { onClose: () => void; children: ReactNode; header?: ReactNode }): JSX.Element {
  return (
    <div onClick={onClose} style={css('position:fixed;inset:0;background:rgba(10,11,14,.6);z-index:1000;display:flex;flex-direction:column;justify-content:flex-end')}>
      <div onClick={(e) => e.stopPropagation()} style={css('background:#141418;border-top:1px solid rgba(255,255,255,.09);border-radius:18px 18px 0 0;box-shadow:0 -14px 44px rgba(0,0,0,.55);display:flex;flex-direction:column;height:82vh;max-height:92vh')}>
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
  const addAllToTimeline = useStore((s) => s.addAllToTimeline)
  const canSequence = library.some((it) => it.kind === 'video' || it.kind === 'image')
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
      {canSequence && (
        <div style={css('flex:none;padding:0 14px 10px')}>
          <button onClick={() => { addAllToTimeline(); onClose() }} style={css('width:100%;background:none;border:1px solid rgba(255,255,255,.12);color:#C6C9D2;font-family:inherit;font-size:13px;font-weight:550;border-radius:10px;padding:11px 0;cursor:pointer')}>▦ Add all to timeline</button>
        </div>
      )}
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

// Audio sheet — the desktop AudioTab on a phone: import audio, then tap a clip to
// drop it on an audio track (the SAME addMediaToTimeline path the desktop uses).
function MusicSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const library = useStore((s) => s.library)
  const addToLibrary = useStore((s) => s.addToLibrary)
  const audio = library.filter((it) => it.kind === 'audio')
  const fmt = (it: LibraryItem): string =>
    it.duration ? `${Math.floor(it.duration / 60)}:${String(Math.round(it.duration % 60)).padStart(2, '0')}` : ''
  return (
    <Sheet
      onClose={onClose}
      header={
        <div style={css('flex:none;display:flex;align-items:center;justify-content:space-between;padding:6px 16px 12px')}>
          <div style={css('font-size:15px;font-weight:650')}>Audio</div>
          <button onClick={addToLibrary} style={css('background:rgba(110,106,232,.16);border:1px solid rgba(110,106,232,.3);color:#B7B5F4;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:7px 14px;cursor:pointer')}>＋ Import audio</button>
        </div>
      }
    >
      <div style={css('flex:1;min-height:0;overflow:auto;padding:0 14px 20px;display:flex;flex-direction:column;gap:8px')}>
        {audio.length === 0 && (
          <div style={css('color:#686E7B;font-size:13px;text-align:center;padding:32px 16px;line-height:1.6')}>No audio yet — tap ＋ Import audio to add music or a voiceover. It drops onto an audio track.</div>
        )}
        {audio.map((it) => (
          <div key={it.id} onClick={() => { addMediaToTimeline(it); onClose() }} style={css('display:flex;gap:11px;align-items:center;padding:10px;border-radius:12px;background:#1E2026;border:1px solid rgba(255,255,255,.07);cursor:pointer')}>
            <div style={css('width:44px;height:44px;flex:none;border-radius:9px;background:#23252b;display:grid;place-items:center;color:#8890A0')}><Icon name="music" size={20} /></div>
            <div style={css('flex:1;min-width:0')}>
              <div style={css('font-size:13px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{it.name}</div>
              <div style={css("font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#686E7B;margin-top:3px")}>{fmt(it)}</div>
            </div>
            <span style={css('font-size:16px;color:#B7B5F4;flex:none')}>＋</span>
          </div>
        ))}
      </div>
    </Sheet>
  )
}

// Captions sheet — the desktop CaptionsTab on a phone: turn the transcript into
// subtitle text clips, show the count, and clear.
function CaptionsSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const generateCaptions = useStore((s) => s.generateCaptions)
  const clearCaptions = useStore((s) => s.clearCaptions)
  const hasTranscript = useStore((s) => !!s.project.transcript?.words?.length)
  const jobActive = useStore((s) => s.job.active)
  const jobMsg = useStore((s) => s.job.message)
  const snap = useSharedEngineSnapshot()
  const capCount = countCaptionTexts(snap?.doc)
  const [style, setStyle] = useState<string>(DEFAULT_CAPTION_STYLE)
  return (
    <Sheet onClose={onClose} header={<div style={css('flex:none;padding:6px 16px 12px;font-size:15px;font-weight:650')}>Captions</div>}>
      <div style={css('flex:1;min-height:0;overflow:auto;padding:2px 16px 20px')}>
        <div style={css('font-size:11.5px;font-weight:650;color:#8f8f96;letter-spacing:.3px;text-transform:uppercase;margin-bottom:9px')}>Style</div>
        <div style={css('display:flex;gap:10px;margin-bottom:16px')}>
          {CAPTION_STYLES.map((s) => {
            const on = style === s.id
            return (
              <button key={s.id} onClick={() => setStyle(s.id)}
                style={css(`flex:1;text-align:left;border-radius:13px;padding:12px 13px;cursor:pointer;background:${on ? 'rgba(124,92,255,.14)' : '#17171b'};border:1px solid ${on ? 'rgba(124,92,255,.55)' : 'rgba(255,255,255,.07)'}`)}>
                {/* mini preview of the look */}
                <div style={css(`height:34px;border-radius:8px;display:grid;place-items:center;margin-bottom:9px;background:${s.id === 'boxed' ? '#000' : 'linear-gradient(135deg,#2a2a33,#1b1b22)'}`)}>
                  <span style={css(`font-size:14px;font-weight:800;color:#fff;${s.id === 'clean' ? '-webkit-text-stroke:1px #000;text-shadow:0 1px 2px rgba(0,0,0,.9)' : s.id === 'boxed' ? 'background:#000;padding:1px 7px;border-radius:3px' : ''}`)}>Aa</span>
                </div>
                <div style={css(`font-size:13px;font-weight:650;color:${on ? '#c9b8ff' : '#e7e7ea'}`)}>{s.label}</div>
                <div style={css('font-size:11px;color:#8f8f96;margin-top:2px')}>{s.hint}</div>
              </button>
            )
          })}
        </div>
        <button onClick={() => void generateCaptions(style)} disabled={jobActive} style={css(`width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(100deg,#7c5cff,#a468ff);border:none;color:#fff;font-family:inherit;font-size:14px;font-weight:700;border-radius:12px;padding:14px 0;box-shadow:0 6px 18px rgba(140,92,255,.32);opacity:${jobActive ? 0.6 : 1};cursor:${jobActive ? 'default' : 'pointer'}`)}>
          <Icon name="captions" size={19} /> {jobActive ? 'Working…' : capCount > 0 ? 'Regenerate captions' : 'Generate captions'}
        </button>
        {jobActive && jobMsg && <div style={css('margin-top:12px;font-size:12.5px;color:#b9b9c0;text-align:center')}>{jobMsg}</div>}
        {capCount > 0 && !jobActive && (
          <div style={css('margin-top:14px;display:flex;align-items:center;gap:10px;background:#17171b;border-radius:12px;padding:12px 14px')}>
            <div style={css('flex:1;font-size:13px;color:#7ed957')}>{capCount} caption line{capCount === 1 ? '' : 's'} on the timeline</div>
            <button onClick={clearCaptions} style={css('flex:none;background:none;border:1px solid rgba(255,255,255,.14);color:#cfcfd4;font-family:inherit;font-size:13px;border-radius:9px;padding:8px 14px;cursor:pointer')}>Clear</button>
          </div>
        )}
        <div style={css('margin-top:16px;font-size:12.5px;color:#8f8f96;line-height:1.6')}>{hasTranscript ? 'Turns your transcript into subtitle clips on a text track. Tap a line on the timeline to restyle it.' : 'Adds subtitle clips from your speech. If you’ve run Cut Lord it reuses that transcript — otherwise it transcribes first, then captions.'}</div>
      </div>
    </Sheet>
  )
}

function IcBtn({ label, onClick, disabled, active }: { label: ReactNode; onClick: () => void; disabled?: boolean; active?: boolean }): JSX.Element {
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
  const showExportModal = useStore((s) => s.showExportModal)
  const showSettings = useStore((s) => s.showSettings)
  const [sheet, setSheet] = useState<SheetKind>(null)
  const hasBase = !!media || ((useStore.getState().project.baseSequence?.length ?? 0) > 0)

  // Open the Text sheet WITHOUT inserting a clip — the panel's Text tab composes a
  // draft and commits on "Add to timeline" (tapping the Text tool used to auto-drop
  // a "Your text" clip before the user added anything).
  const openTextSheet = (): void => setSheet('text')

  // Register any user-uploaded fonts (+ the chosen default) so they render in the
  // preview and canvas-baked export after a reload.
  useEffect(() => { void loadStoredFonts() }, [])

  // The mobile timeline's empty-lane "＋ Add text / Add music" buttons dispatch
  // ec:sheet — the legacy MobileApp listened for it but this new-UI editor did
  // not, so those buttons were dead. Route each to the matching sheet/action.
  useEffect(() => {
    const open = (e: Event): void => {
      const d = (e as CustomEvent).detail as string
      if (d === 'text') openTextSheet()
      else if (d === 'music') setSheet('music')
      else if (d === 'media') setSheet('media')
      else if (d === 'cut') setSheet('cut')
      else if (d === 'captions') setSheet('captions')
    }
    window.addEventListener('ec:sheet', open)
    return () => window.removeEventListener('ec:sheet', open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Stage height (vh): fixed by default (~46% of the screen) and user-adjustable
  // by dragging the grip under the canvas. A FIXED height is what keeps the
  // timeline from drifting — a flex:1 stage fights the preview's internal
  // min-heights (.video-wrap/.stage) and jumps as media/waveform load.
  const [stageVh, setStageVh] = useState<number>(() => {
    const v = Number(localStorage.getItem('ec.nu.mStageVh'))
    return v >= 22 && v <= 58 ? v : 46
  })
  useEffect(() => {
    localStorage.setItem('ec.nu.mStageVh', String(stageVh))
  }, [stageVh])
  // Consume the pointer-down (preventDefault + stopPropagation) so iOS doesn't
  // hijack the touch as a page scroll before the drag starts; window listeners
  // then drive the move. Pointer events only (no touch+mouse) — avoids the iOS
  // double-drag from simulated mouse events.
  function startStageDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const vh0 = stageVh
    const y0 = e.clientY
    const onMove = (ev: PointerEvent): void => {
      const dvh = ((ev.clientY - y0) / window.innerHeight) * 100
      setStageVh(Math.min(58, Math.max(22, vh0 + dvh)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div style={css('width:100%;height:100%;background:#0b0b0d;display:flex;flex-direction:column;overflow:hidden')} className="ec-newui ec-m-editor">
      {/* Top bar — back · 9:16 marker · settings + gradient Export (design) */}
      <div style={css(`flex:none;display:flex;align-items:center;height:52px;padding:0 12px;border-bottom:1px solid ${HAIR};position:relative`)} title={name}>
        <div onClick={goHome} style={css('width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:10px;color:#e7e7ea;cursor:pointer')}><Icon name="back" size={22} /></div>
        <div style={css('position:absolute;left:50%;transform:translateX(-50%);display:flex;align-items:center;justify-content:center;width:16px;height:25px;border:1.6px solid #fff;border-radius:5px;font-size:6.5px;font-weight:700;letter-spacing:.2px;color:#fff')}>9:16</div>
        <div style={css('margin-left:auto;display:flex;align-items:center;gap:10px')}>
          <div onClick={() => setShowSettings(true)} style={css('width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:9px;color:#bdbdc4;cursor:pointer')}><Icon name="more" size={20} /></div>
          <button onClick={() => setShowExportModal(true)} style={css('background:linear-gradient(100deg,#7c5cff,#a468ff);border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:700;border-radius:10px;padding:8px 18px;cursor:pointer;box-shadow:0 2px 12px rgba(140,92,255,.35)')}>Export</button>
        </div>
      </div>

      {/* Stage — FIXED height; production preview (its own transport is hidden via CSS) */}
      <div className="ec-legacy ec-m-stage" style={css(`flex:none;height:${stageVh}vh;min-height:0;display:flex;flex-direction:column;background:#000`)}>
        <VideoPreview />
      </div>

      {/* Stage resize grip */}
      <div onPointerDown={startStageDrag} style={css('flex:none;height:20px;display:grid;place-items:center;cursor:row-resize;touch-action:none')}>
        <span style={css('width:44px;height:4px;border-radius:2px;background:rgba(255,255,255,.18)')} />
      </div>

      {/* Transport — Material undo/redo · filled play · zoom (all wiring kept) */}
      <div style={css(`flex:none;display:flex;align-items:center;gap:4px;padding:7px 12px;border-top:1px solid ${HAIR}`)}>
        <IcBtn label={<Icon name="undo" size={21} />} onClick={() => canUndo && undo()} disabled={!canUndo} />
        <IcBtn label={<Icon name="redo" size={21} />} onClick={() => canRedo && redo()} disabled={!canRedo} />
        <div style={css('flex:1')} />
        <button onClick={() => { if (!hasBase) return; const next = !playing; if (next) primePlayback(); setPlaying(next) }} disabled={!hasBase} style={css(`width:44px;height:44px;border-radius:50%;background:${hasBase ? 'rgba(255,255,255,.08)' : 'transparent'};border:none;display:grid;place-items:center;color:${hasBase ? '#fff' : '#4A4F5B'};cursor:${hasBase ? 'pointer' : 'default'}`)}>
          <Icon name={playing ? 'pause' : 'play'} size={30} fill />
        </button>
        <div style={css('flex:1')} />
        <IcBtn label="−" onClick={() => zoomStep(1 / 1.4)} />
        <IcBtn label="＋" onClick={() => zoomStep(1.4)} />
      </div>

      {/* Mobile timeline — grows to fill the space between the fixed stage and dock */}
      <div className="ec-legacy ec-m-tl" style={css(`flex:1;min-height:120px;border-top:1px solid ${HAIR};position:relative`)}>
        <TimelinePanel mobile />
      </div>

      {/* Bottom dock — Import + Cut Lord (contextual tools when a clip is selected) */}
      <div className="ec-legacy ec-m-dock" style={css(`flex:none;border-top:1px solid ${HAIR};background:#0b0b0d`)}>
        <MobileTools
          onImport={() => setSheet('media')}
          onCutlord={() => setSheet('cut')}
          onEditText={() => setSheet('text')}
          onAddText={openTextSheet}
          onAddAudio={() => setSheet('music')}
          onCaptions={() => setSheet('captions')}
          onSticker={() => void useStore.getState().importOverlayFromDevice()}
        />
      </div>

      {/* Sheets + modals */}
      {sheet === 'cut' && (
        <Sheet onClose={() => setSheet(null)}>
          <RetakeCleanerPanel />
        </Sheet>
      )}
      {sheet === 'media' && <MediaSheet onClose={() => setSheet(null)} />}
      {sheet === 'music' && <MusicSheet onClose={() => setSheet(null)} />}
      {sheet === 'captions' && <CaptionsSheet onClose={() => setSheet(null)} />}
      {sheet === 'text' && (
        <Sheet onClose={() => setSheet(null)} header={<div style={css('flex:none;padding:6px 16px 12px;font-size:15px;font-weight:650')}>Text</div>}>
          <MobileTextPanel />
        </Sheet>
      )}
      <SilenceSettingsModal />
      {showExportModal && createPortal(<MobileExportDrawer />, document.body)}
      {showSettings && createPortal(<SettingsModal />, document.body)}
    </div>
  )
}
