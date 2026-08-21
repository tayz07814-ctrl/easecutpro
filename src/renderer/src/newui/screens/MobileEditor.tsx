import { useState, useEffect, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { css } from '../css'
import { useStore } from '../../store'
import type { LibraryItem } from '@shared/types'
import VideoPreview from '../../components/VideoPreview'
import TimelinePanel from '../timeline/TimelinePanel'
import { MobileTools } from '../../components/mobile/MobileTools'
import { Icon } from '../../components/mobile/Icon'
import MobileTextPanel from '../../components/mobile/MobileTextPanel'
import MobileEaseTools from './MobileEaseTools'
import SilenceMasterySettingsModal from './SilenceMasterySettingsModal'
import MobileExportDrawer from '../../components/mobile/MobileExportDrawer'
import SettingsModal from '../../components/SettingsModal'
import { getSharedEngine, useSharedEngineSnapshot } from '../../timelineEngine'
import { primePlayback } from '../../clock'
import { addMediaToTimeline } from '../../timelineAdd'
import { countCaptionTexts } from '../../docTextClips'
import { loadStoredFonts } from '../../customFonts'
import { DEFAULT_CAPTION_STYLE } from '../../captionStyles'
import TextPresetStrip from './TextPresetStrip'

const HAIR = 'rgba(255,255,255,.06)'

type SheetKind = 'cut' | 'media' | 'text' | 'music' | 'captions' | null

function Sheet({ onClose, children, header }: { onClose: () => void; children: ReactNode; header?: ReactNode }): JSX.Element {
  return (
    <div onClick={onClose} style={css('position:fixed;inset:0;background:rgba(8,8,10,.6);z-index:1000;display:flex;flex-direction:column;justify-content:flex-end')}>
      <div onClick={(e) => e.stopPropagation()} style={css('background:#141418;border-top:1px solid rgba(255,255,255,.09);border-radius:18px 18px 0 0;box-shadow:0 -14px 44px rgba(0,0,0,.55);display:flex;flex-direction:column;max-height:92vh;height:82vh')}>
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
    <Sheet onClose={onClose} header={
      <div style={css('flex:none;display:flex;align-items:center;justify-content:space-between;padding:6px 16px 12px')}>
        <div style={css('font-size:15px;font-weight:650')}>Media</div>
        <button onClick={addToLibrary} style={css('background:rgba(124,107,255,.16);border:1px solid rgba(124,107,255,.3);color:#a99bff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:7px 14px;cursor:pointer')}>＋ Import</button>
      </div>
    }>
      {canSequence && <div style={css('flex:none;padding:0 14px 10px')}><button onClick={() => { addAllToTimeline(); onClose() }} style={css('width:100%;background:none;border:1px solid rgba(255,255,255,.12);color:#c9c9da;font-family:inherit;font-size:13px;font-weight:550;border-radius:10px;padding:11px 0;cursor:pointer')}>▦ Add all to timeline</button></div>}
      <div style={css('flex:1;min-height:0;overflow:auto;padding:0 14px 20px;display:flex;flex-direction:column;gap:8px')}>
        {library.length === 0 && <div style={css('color:#6e6e85;font-size:13px;text-align:center;padding:32px 0')}>No clips yet — tap ＋ Import to add videos.</div>}
        {library.map((it) => {
          const isBase = !!basePath && it.path === basePath
          return (
            <div key={it.id} onClick={() => { setBaseFromLibrary(it.id); onClose() }} style={css(`display:flex;gap:11px;align-items:center;padding:10px;border-radius:12px;background:#101015;border:1px solid ${isBase ? 'rgba(124,107,255,.55)' : 'rgba(255,255,255,.07)'};cursor:pointer`)}>
              <div style={css('width:44px;height:56px;flex:none;border-radius:7px;overflow:hidden;background:#141419;display:grid;place-items:center')}>{it.thumb ? <img src={it.thumb} alt="" style={css('width:100%;height:100%;object-fit:cover')} /> : <span style={css("font-family:'Geist Mono',monospace;font-size:9px;color:#6e6e85")}>9:16</span>}</div>
              <div style={css('flex:1;min-width:0')}><div style={css('font-size:13px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{it.name}</div><div style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#6e6e85;margin-top:3px")}>{fmt(it)}</div></div>
              {isBase && <span style={css('font-size:10px;font-weight:600;color:#a99bff;background:rgba(124,107,255,.18);border-radius:5px;padding:2px 7px;flex:none')}>Base</span>}
            </div>
          )
        })}
      </div>
    </Sheet>
  )
}
function MusicSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const library = useStore((s) => s.library)
  const addToLibrary = useStore((s) => s.addAudioToLibrary)
  const audio = library.filter((it) => it.kind === 'audio')
  const fmt = (it: LibraryItem): string => it.duration ? `${Math.floor(it.duration / 60)}:${String(Math.round(it.duration % 60)).padStart(2, '0')}` : ''
  return (
    <Sheet onClose={onClose} header={<div style={css('flex:none;display:flex;align-items:center;justify-content:space-between;padding:6px 16px 12px')}><div style={css('font-size:15px;font-weight:650')}>Audio</div><button onClick={addToLibrary} style={css('background:rgba(124,107,255,.16);border:1px solid rgba(124,107,255,.3);color:#a99bff;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:7px 14px;cursor:pointer')}>＋ Import audio</button></div>}>
      <div style={css('flex:1;min-height:0;overflow:auto;padding:0 14px 20px;display:flex;flex-direction:column;gap:8px')}>
        {audio.length === 0 && <div style={css('color:#6e6e85;font-size:13px;text-align:center;padding:32px 16px;line-height:1.6')}>No audio yet — tap ＋ Import audio to add music or a voiceover.</div>}
        {audio.map((it) => <div key={it.id} onClick={() => { addMediaToTimeline(it); onClose() }} style={css('display:flex;gap:11px;align-items:center;padding:10px;border-radius:12px;background:#101015;border:1px solid rgba(255,255,255,.07);cursor:pointer')}><div style={css('width:44px;height:44px;flex:none;border-radius:9px;background:#141419;display:grid;place-items:center;color:#8b8ba0')}><Icon name="music" size={20} /></div><div style={css('flex:1;min-width:0')}><div style={css('font-size:13px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{it.name}</div><div style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#6e6e85;margin-top:3px")}>{fmt(it)}</div></div><span style={css('font-size:16px;color:#a99bff;flex:none')}>＋</span></div>)}
      </div>
    </Sheet>
  )
}
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
        <TextPresetStrip title="Style" current={null} selectedId={style} onApply={(_s, p) => setStyle(p.id)} />
        <div style={css('height:16px')} />
        <button onClick={() => void generateCaptions(style)} disabled={jobActive} style={css(`width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(100deg,#7c6bff,#8e7fff);border:none;color:#fff;font-family:inherit;font-size:14px;font-weight:700;border-radius:12px;padding:14px 0;box-shadow:0 6px 18px rgba(124,107,255,.32);opacity:${jobActive ? 0.6 : 1};cursor:${jobActive ? 'default' : 'pointer'}`)}><Icon name="captions" size={19} /> {jobActive ? 'Working…' : capCount > 0 ? 'Regenerate captions' : 'Generate captions'}</button>
        {jobActive && jobMsg && <div style={css('margin-top:12px;font-size:12.5px;color:#b9b9cc;text-align:center')}>{jobMsg}</div>}
        {capCount > 0 && !jobActive && <div style={css('margin-top:14px;display:flex;align-items:center;gap:10px;background:#08080a;border-radius:12px;padding:12px 14px')}><div style={css('flex:1;font-size:13px;color:#7ed6a6')}>{capCount} caption line{capCount === 1 ? '' : 's'} on the timeline</div><button onClick={clearCaptions} style={css('flex:none;background:none;border:1px solid rgba(255,255,255,.14);color:#c9c9da;font-family:inherit;font-size:13px;border-radius:9px;padding:8px 14px;cursor:pointer')}>Clear</button></div>}
        <div style={css('margin-top:16px;font-size:12.5px;color:#8b8ba0;line-height:1.6')}>{hasTranscript ? 'Turns your transcript into subtitle clips on a text track. Tap a line on the timeline to restyle it.' : 'Adds subtitle clips from your speech. If you’ve run Cut Lord it reuses that transcript — otherwise it transcribes first, then captions.'}</div>
      </div>
    </Sheet>
  )
}

export default function MobileEditor(): JSX.Element {
  useSharedEngineSnapshot()
  const media = useStore((s) => s.project.media)
  const project = useStore((s) => s.project)
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
  const snap = useSharedEngineSnapshot()
  const openTextSheet = (): void => setSheet('text')
  useEffect(() => { void loadStoredFonts() }, [])
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
  }, [])

  const [stageVh, setStageVh] = useState<number>(() => {
    const v = Number(localStorage.getItem('ec.nu.mStageVh'))
    return v >= 22 && v <= 58 ? v : 46
  })
  useEffect(() => { localStorage.setItem('ec.nu.mStageVh', String(stageVh)) }, [stageVh])
  function startStageDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault(); e.stopPropagation()
    const vh0 = stageVh; const y0 = e.clientY
    const onMove = (ev: PointerEvent): void => { const dvh = ((ev.clientY - y0) / window.innerHeight) * 100; setStageVh(Math.min(58, Math.max(22, vh0 + dvh))) }
    const onUp = (): void => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp) }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp)
  }

  const aspect = project.aspectW && project.aspectH ? project.aspectW / project.aspectH : (project.media?.width && project.media?.height ? project.media.width / project.media.height : 9/16)
  const aspectLabel = (() => {
    const named: Record<string, number> = {'9:16':9/16,'3:4':3/4,'4:5':4/5,'1:1':1,'4:3':4/3,'16:9':16/9}
    let best=''; let bestD=0.06
    for (const [k,r] of Object.entries(named)){ const d=Math.abs(aspect-r)/r; if(d<bestD){bestD=d; best=k}}
    return best || aspect.toFixed(2)
  })()
  const isPortrait = aspect < 1

  return (
    <div style={css('width:100%;height:100%;background:#0B0B0D;display:flex;flex-direction:column;overflow:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)')} className="ec-newui ec-m-editor">
      {/* Top bar — Flutter _topBar: back · undo/redo · [center 9:16] · more · Export */}
      <div style={css('flex:none;display:flex;align-items:center;height:52px;padding:0 12px;border-bottom:1px solid rgba(255,255,255,.06);position:relative;background:#0B0B0D')}>
        <div onClick={goHome} style={css('width:38px;height:38px;display:flex;align-items:center;justify-content:center;color:#E7E7EA;cursor:pointer')}><Icon name="back" size={26} /></div>
        <div onClick={() => canUndo && undo()} style={css(`width:34px;height:34px;display:grid;place-items:center;color:${canUndo ? '#C6C9D2' : '#4A4F5B'};cursor:${canUndo?'pointer':'default'}`)}><Icon name="undo" size={20} /></div>
        <div onClick={() => canRedo && redo()} style={css(`width:34px;height:34px;display:grid;place-items:center;color:${canRedo ? '#C6C9D2' : '#4A4F5B'};cursor:${canRedo?'pointer':'default'}`)}><Icon name="redo" size={20} /></div>
        <div style={css('position:absolute;left:50%;transform:translateX(-50%)')} onClick={() => hasBase && setShowExportModal(true)}>
          <div style={css(`width:${isPortrait?16:25}px;height:${isPortrait?25:16}px;display:grid;place-items:center;border:1.6px solid #fff;border-radius:5px;color:#fff;font-size:6.5px;font-weight:700;cursor:${hasBase?'pointer':'default'}`)}>{aspectLabel}</div>
        </div>
        <div style={css('margin-left:auto;display:flex;align-items:center;gap:6px')}>
          <div onClick={() => setShowSettings(true)} style={css('width:34px;height:34px;display:grid;place-items:center;color:#BDBDC4;cursor:pointer')}><Icon name="more" size={20} /></div>
          <button onClick={() => setShowExportModal(true)} style={css('background:linear-gradient(100deg,#7C5CFF,#A468FF);border:none;color:#fff;font-family:InstrumentSans,sans-serif;font-size:13px;font-weight:700;border-radius:10px;padding:8px 18px;cursor:pointer;box-shadow:0 2px 12px rgba(124,92,255,.35)')}>Export</button>
        </div>
      </div>

      {/* Stage — Flutter _stage: height screenH*stageFrac, bg stage #000, texture */}
      <div className="ec-legacy ec-m-stage" style={css(`flex:none;height:${stageVh}vh;min-height:0;display:flex;flex-direction:column;background:#000`)}>
        <VideoPreview />
      </div>
      <div onPointerDown={startStageDrag} style={css('flex:none;height:20px;display:grid;place-items:center;cursor:row-resize;touch-action:none;background:#0B0B0D')}>
        <span style={css('width:44px;height:4px;border-radius:2px;background:rgba(255,255,255,.18)')} />
      </div>

      {/* Transport — Flutter _transport: undo/redo · play (44 circle) · Split/Delete */}
      <div style={css('flex:none;display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid rgba(255,255,255,.06);background:#0B0B0D')}>
        <div onClick={() => canUndo && undo()} style={css(`width:34px;height:38px;display:grid;place-items:center;color:${canUndo ? '#C6C9D2' : '#4A4F5B'};cursor:pointer`)}><Icon name="undo" size={20} /></div>
        <div onClick={() => canRedo && redo()} style={css(`width:34px;height:38px;display:grid;place-items:center;color:${canRedo ? '#C6C9D2' : '#4A4F5B'};cursor:pointer`)}><Icon name="redo" size={20} /></div>
        <div style={css('flex:1')} />
        <button onClick={() => { if (!hasBase) return; const next=!playing; if(next) primePlayback(); setPlaying(next)}} disabled={!hasBase} style={css(`width:44px;height:44px;border-radius:50%;background:${hasBase?'rgba(255,255,255,.08)':'transparent'};border:none;display:grid;place-items:center;color:${hasBase?'#fff':'#4A4F5B'};cursor:${hasBase?'pointer':'default'}`)}><Icon name={playing?'pause':'play'} size={30} fill /></button>
        <div style={css('flex:1')} />
        <div onClick={() => hasBase && getSharedEngine()?.splitAtPlayhead()} style={css(`width:34px;height:34px;display:grid;place-items:center;color:${hasBase?'#C6C9D2':'#4A4F5B'};cursor:${hasBase?'pointer':'default'}`)}><Icon name="split" size={20} /></div>
        <div onClick={() => hasBase && getSharedEngine()?.deleteSelection(true)} style={css(`width:34px;height:34px;display:grid;place-items:center;color:${hasBase?'#FF8A9A':'#4A4F5B'};cursor:${hasBase?'pointer':'default'}`)}><Icon name="trash" size={20} /></div>
      </div>

      {/* Timeline — Flutter MiniTimeline */}
      <div className="ec-legacy ec-m-tl" style={css('flex:1;min-height:120px;border-top:1px solid rgba(255,255,255,.06);position:relative;background:#0B0B0D')}>
        <TimelinePanel mobile />
      </div>

      {/* Bottom dock — ToolDock / SelectedToolbar */}
      <div className="ec-legacy ec-m-dock" style={css('flex:none;border-top:1px solid rgba(255,255,255,.06);background:#0B0B0D;padding-bottom:max(env(safe-area-inset-bottom,0px),0px)')}>
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

      {sheet === 'cut' && <Sheet onClose={() => setSheet(null)}><MobileEaseTools onClose={() => setSheet(null)} /></Sheet>}
      {sheet === 'media' && <MediaSheet onClose={() => setSheet(null)} />}
      {sheet === 'music' && <MusicSheet onClose={() => setSheet(null)} />}
      {sheet === 'captions' && <CaptionsSheet onClose={() => setSheet(null)} />}
      {sheet === 'text' && <Sheet onClose={() => setSheet(null)} header={<div style={css('flex:none;padding:6px 16px 12px;font-size:15px;font-weight:650')}>Text</div>}><MobileTextPanel /></Sheet>}
      <SilenceMasterySettingsModal />
      {showExportModal && createPortal(<MobileExportDrawer />, document.body)}
      {showSettings && createPortal(<SettingsModal />, document.body)}
    </div>
  )
}
