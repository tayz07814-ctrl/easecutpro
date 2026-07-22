// The CapCut-style contextual dock (0.01 redesign). Nothing selected → the MAIN
// toolbar (Edit / Music / Effect / Text / ScriptCut / Captions). A clip selected →
// the main toolbar HIDES and a context editing toolbar appears (Duration / Split /
// Animation / AI Upscaler / Crop / … / Delete), led by a collapse chevron (deselect)
// and topped by a floating two-pill quick-action bar (Layer · Keyframe · Duplicate |
// Flip · Delete). Text + audio clips get their own toolbars. All edits drive the
// shared engine; features EaseCutPro doesn't have yet toast "coming soon".

import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { useSharedEngineSnapshot, getSharedEngine } from '../../timelineEngine'
import { findClip } from '@shared/timeline/model'
import { framesToSeconds } from '@shared/timeline/time'
import * as C from '@shared/timeline/commands'
import { Icon, type IconName } from './Icon'
import MobileCropModal from './MobileCropModal'

const mnum = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)

/** A labelled tool button (icon over caption). `badge` shows a tiny pill (e.g.
 *  OFF). `tint` colours AI tools blue / ScriptCut purple, matching the design. */
function Tool({ icon, label, onClick, active, badge, tint }: { icon: IconName; label: string; onClick: () => void; active?: boolean; badge?: string; tint?: 'ai' | 'accent' }): JSX.Element {
  return (
    <button className={'mt-tool' + (active ? ' on' : '') + (tint ? ' ' + tint : '')} onClick={onClick}>
      <span className="mt-tool-ic">
        <Icon name={icon} />
        {badge && <span className="mt-tool-badge">{badge}</span>}
      </span>
      <span className="mt-tool-lb">{label}</span>
    </button>
  )
}

/** A labelled slider row used inside child panels. */
function SliderRow({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number
  fmt: (v: number) => string; onChange: (v: number) => void
}): JSX.Element {
  return (
    <label className="mt-slider">
      <span className="mt-slider-lb">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="mt-slider-val">{fmt(value)}</span>
    </label>
  )
}

/** Preset chips (e.g. speed 1×, 2×). */
function Chips({ options, value, onPick }: { options: { label: string; v: number }[]; value: number; onPick: (v: number) => void }): JSX.Element {
  return (
    <div className="mt-chips">
      {options.map((o) => (
        <button key={o.label} className={'mt-chip' + (Math.abs(value - o.v) < 1e-6 ? ' on' : '')} onClick={() => onPick(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function MobileTools({ onImport, onCutlord, onEditText, onAddText, onAddAudio, onCaptions }: {
  onImport: () => void
  onCutlord: () => void
  onEditText: () => void
  /** create a new text layer at the playhead and open its editor. */
  onAddText?: () => void
  /** open the Audio sheet (import + add a music/voiceover clip). */
  onAddAudio?: () => void
  /** open the Captions sheet (generate / clear subtitle clips). */
  onCaptions?: () => void
  /** pick an image and drop it on an overlay track (sticker / logo). Kept for
   *  callers (MobileEditor passes it); overlay import now lives on the clip's
   *  Overlay tool, so the main toolbar no longer surfaces it. */
  onSticker?: () => void
}): JSX.Element {
  const snap = useSharedEngineSnapshot()
  // The shared engine's doc is authoritative even before project.timeline
  // materializes (fresh projects are BRIDGED into a doc).
  const docMode = !!snap?.doc
  const selId = docMode ? snap!.interaction.selection[0] ?? null : null
  const loc = selId && snap?.doc ? findClip(snap.doc, selId) : null
  const clip = loc?.clip ?? null
  const kind: 'none' | 'video' | 'text' | 'audio' =
    !clip ? 'none' : clip.kind === 'text' || clip.kind === 'title' ? 'text' : clip.kind === 'audio' ? 'audio' : 'video'

  const [panel, setPanel] = useState<string | null>(null)
  const [cropOpen, setCropOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => { setPanel(null); setCropOpen(false) }, [selId]) // reset open panel / crop on selection change
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(t)
  }, [toast])

  const engine = getSharedEngine()
  const dispatch = (cmd: ReturnType<typeof C.setClipSpeed>): void => void engine?.dispatch(cmd)
  const soon = (what: string): void => setToast(`${what} — coming soon`)
  const toastEl = toast ? <div className="mt-toast">{toast}</div> : null

  // ---- nothing selected: the MAIN toolbar ----
  if (kind === 'none' || !clip) {
    // "Edit" reveals a clip's editing toolbar by selecting the base clip; with no
    // media yet it falls back to importing.
    const mainClip = snap?.doc.tracks.find((t) => t.isMain)?.clips[0] ?? null
    return (
      <div className="mt-dock">
        {toastEl}
        <div className="mt-row mt-main">
          <Tool icon="edit" label="Edit" onClick={() => (mainClip ? engine?.select([mainClip.id]) : onImport())} />
          <Tool icon="music" label="Music" onClick={() => (onAddAudio ? onAddAudio() : soon('Music'))} />
          <Tool icon="text" label="Text" onClick={() => (onAddText ? onAddText() : onEditText())} />
          <Tool icon="scriptcut" label="Cut Lord" onClick={onCutlord} tint="accent" />
          <Tool icon="captions" label="Captions" onClick={() => (onCaptions ? onCaptions() : soon('Captions'))} />
        </div>
      </div>
    )
  }

  const m = clip.metadata ?? {}
  const durSec = snap ? framesToSeconds(clip.duration, snap.doc.timebase) : 0

  // ---- a child panel is open ----
  if (panel) {
    const back = (
      <button className="mt-back" onClick={() => setPanel(null)}>
        <Icon name="back" size={18} />
      </button>
    )
    let title = panel
    let body: JSX.Element | null = null
    if (panel === 'duration') {
      title = 'Duration'
      const sp = clip.speed ?? 1
      body = (
        <>
          <p className="mt-note">Clip length: {durSec.toFixed(1)}s · speed changes how long it plays.</p>
          <Chips options={[{ label: '0.5×', v: 0.5 }, { label: '1×', v: 1 }, { label: '1.5×', v: 1.5 }, { label: '2×', v: 2 }]} value={sp} onPick={(v) => dispatch(C.setClipSpeed(clip.id, v))} />
          <SliderRow label="Speed" value={sp} min={0.25} max={4} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => dispatch(C.setClipSpeed(clip.id, v))} />
        </>
      )
    } else if (panel === 'speed') {
      title = 'Speed'
      const sp = clip.speed ?? 1
      body = (
        <>
          <Chips options={[{ label: '0.5×', v: 0.5 }, { label: '1×', v: 1 }, { label: '1.5×', v: 1.5 }, { label: '2×', v: 2 }, { label: '3×', v: 3 }]} value={sp} onPick={(v) => dispatch(C.setClipSpeed(clip.id, v))} />
          <SliderRow label="Speed" value={sp} min={0.25} max={4} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => dispatch(C.setClipSpeed(clip.id, v))} />
        </>
      )
    } else if (panel === 'zoom') {
      title = 'Zoom'
      body = (
        <>
          <SliderRow label="Size" value={mnum(m.ovScale, 1)} min={0.2} max={3} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => void engine?.dispatch(C.setOverlayPlacement(clip.id, { ovScale: v }))} />
          <SliderRow label="Zoom start" value={mnum(m.ovZoomStart, 1)} min={1} max={4} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => void engine?.dispatch(C.setOverlayPlacement(clip.id, { ovZoomStart: v }))} />
          <SliderRow label="Zoom end" value={mnum(m.ovZoomEnd, 1)} min={1} max={4} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => void engine?.dispatch(C.setOverlayPlacement(clip.id, { ovZoomEnd: v }))} />
          <Chips options={[{ label: 'Reset', v: 1 }, { label: 'Punch in', v: 1.3 }]} value={mnum(m.ovZoomEnd, 1)} onPick={(v) => void engine?.dispatch(C.setOverlayPlacement(clip.id, { ovZoomStart: 1, ovZoomEnd: v }))} />
        </>
      )
    } else if (panel === 'adjust') {
      title = 'Adjust'
      body = (
        <>
          <SliderRow label="Size" value={mnum(m.ovScale, 1)} min={0.2} max={3} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => void engine?.dispatch(C.setOverlayPlacement(clip.id, { ovScale: v }))} />
          <SliderRow label="Position X" value={mnum(m.ovX, 0)} min={-0.5} max={0.5} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => void engine?.dispatch(C.setOverlayPlacement(clip.id, { ovX: v }))} />
          <SliderRow label="Position Y" value={mnum(m.ovY, 0)} min={-0.5} max={0.5} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => void engine?.dispatch(C.setOverlayPlacement(clip.id, { ovY: v }))} />
          <SliderRow label="Volume" value={clip.gain ?? 1} min={0} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => void engine?.dispatch(C.setClipGain(clip.id, v))} />
        </>
      )
    } else if (panel === 'volume') {
      title = 'Volume'
      body = <SliderRow label="Volume" value={clip.gain ?? 1} min={0} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => void engine?.dispatch(C.setClipGain(clip.id, v))} />
    } else if (panel === 'animation') {
      title = 'Animation'
      const cur = typeof m.overlayAnimation === 'string' ? m.overlayAnimation : 'none'
      const set = (a: string): void => void engine?.dispatch(C.setClipMetadata(clip.id, { overlayAnimation: a }))
      body = (
        <>
          <div className="mt-chips">
            {['none', 'fade', 'pop', 'slide', 'zoom'].map((a) => (
              <button key={a} className={'mt-chip' + (cur === a ? ' on' : '')} onClick={() => set(a)}>{a}</button>
            ))}
          </div>
          <p className="mt-note">Live animation preview is coming soon — the choice is saved on the clip.</p>
        </>
      )
    }
    return (
      <div className="mt-dock">
        {toastEl}
        <div className="mt-panel-head">
          {back}
          <span className="mt-panel-title">{title}</span>
        </div>
        <div className="mt-panel-body">{body}</div>
      </div>
    )
  }

  // ---- floating two-pill quick-action bar (shared by every selected clip) ----
  const quick = (
    <div className="mt-quick2">
      <div className="mt-quick-grp">
        <button onClick={() => soon('Layer')} title="Layer"><Icon name="layers" size={18} /></button>
        <button onClick={() => soon('Keyframe')} title="Keyframe"><Icon name="kfAdd" size={18} /></button>
        <button onClick={() => engine?.duplicateSelection()} title="Duplicate"><Icon name="duplicate" size={18} /></button>
      </div>
      <div className="mt-quick-grp">
        <button onClick={() => soon('Flip')} title="Flip"><Icon name="flip" size={18} /></button>
        <button className="danger" onClick={() => engine?.deleteSelection(true)} title="Delete"><Icon name="trash" size={18} /></button>
      </div>
    </div>
  )

  // Leads each selected toolbar — collapse back to the main toolbar (deselect).
  const collapse = (
    <button className="mt-collapse" onClick={() => engine?.select([])} title="Done">
      <Icon name="chevronDown" size={20} />
    </button>
  )

  // ---- text clip toolbar ----
  if (kind === 'text') {
    return (
      <div className="mt-dock">
        {toastEl}
        {quick}
        <div className="mt-row">
          {collapse}
          <Tool icon="text" label="Edit" onClick={onEditText} />
          <Tool icon="split" label="Split" onClick={() => engine?.splitAtPlayhead()} />
          <Tool icon="animation" label="Animation" onClick={() => setPanel('animation')} />
          <Tool icon="duplicate" label="Copy" onClick={() => engine?.duplicateSelection()} />
          <Tool icon="trash" label="Delete" onClick={() => engine?.deleteSelection(true)} />
        </div>
      </div>
    )
  }

  // ---- audio clip toolbar ----
  if (kind === 'audio') {
    return (
      <div className="mt-dock">
        {toastEl}
        {quick}
        <div className="mt-row">
          {collapse}
          <Tool icon="duration" label="Duration" onClick={() => setPanel('duration')} />
          <Tool icon="volume" label="Volume" onClick={() => setPanel('volume')} />
          <Tool icon="speed" label="Speed" onClick={() => setPanel('speed')} />
          <Tool icon="split" label="Split" onClick={() => engine?.splitAtPlayhead()} />
          <Tool icon="music" label="Fade" onClick={() => soon('Fade')} />
          <Tool icon="trash" label="Delete" onClick={() => engine?.deleteSelection(true)} />
        </div>
      </div>
    )
  }

  // ---- video / image clip toolbar (mockup order first, extra real tools appended) ----
  const canDetach = clip.hasAudio && !clip.audioDetached
  return (
    <div className="mt-dock">
      {toastEl}
      {cropOpen && <MobileCropModal clip={clip} onClose={() => setCropOpen(false)} />}
      {quick}
      <div className="mt-row">
        {collapse}
        <Tool icon="duration" label="Duration" onClick={() => setPanel('duration')} />
        <Tool icon="split" label="Split" onClick={() => engine?.splitAtPlayhead()} />
        <Tool icon="animation" label="Animation" onClick={() => setPanel('animation')} />
        <Tool icon="upscaler" label="AI Upscaler" badge="OFF" onClick={() => soon('AI Upscaler')} tint="ai" />
        <Tool icon="crop" label="Crop" onClick={() => setCropOpen(true)} />
        <Tool icon="speed" label="Speed" onClick={() => setPanel('speed')} />
        <Tool icon="zoom" label="Zoom" onClick={() => setPanel('zoom')} />
        <Tool icon="adjust" label="Adjust" onClick={() => setPanel('adjust')} />
        <Tool icon="volume" label="Volume" onClick={() => setPanel('volume')} />
        <Tool icon="audioExtract" label="Extract" onClick={() => (canDetach ? engine?.dispatch(C.detachAudio(clip.id)) : soon('Audio already on a lane'))} />
        <Tool icon="overlay" label="Overlay" onClick={() => void useStore.getState().importOverlayFromDevice()} />
        <Tool icon="removeBg" label="Remove BG" onClick={() => soon('Remove BG')} />
        <Tool icon="trash" label="Delete" onClick={() => engine?.deleteSelection(true)} />
      </div>
    </div>
  )
}
