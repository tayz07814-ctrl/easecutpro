// The CapCut-style contextual dock. Nothing selected → Import media + Cut Lord.
// A video/overlay clip → a scrollable tool row (split/speed/crop/remove bg/
// animation/audio extract/adjust/zoom) where each tool opens its own child panel.
// Text and audio clips get their own toolbars. All edits drive the shared engine.

import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { useSharedEngineSnapshot, getSharedEngine } from '../../timelineEngine'
import { findClip } from '@shared/timeline/model'
import { framesToSeconds } from '@shared/timeline/time'
import * as C from '@shared/timeline/commands'
import { Icon, type IconName } from './Icon'

const mnum = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)
const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** A labelled tool button (icon over caption). */
function Tool({ icon, label, onClick, active }: { icon: IconName; label: string; onClick: () => void; active?: boolean }): JSX.Element {
  return (
    <button className={'mt-tool' + (active ? ' on' : '')} onClick={onClick}>
      <span className="mt-tool-ic"><Icon name={icon} /></span>
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

export function MobileTools({ onImport, onCutlord, onEditText }: {
  onImport: () => void
  onCutlord: () => void
  onEditText: () => void
}): JSX.Element {
  const project = useStore((s) => s.project)
  const playhead = useStore((s) => s.project.playhead)
  const snap = useSharedEngineSnapshot()
  const docMode = !!project.timeline && !!snap?.doc
  const selId = docMode ? snap!.interaction.selection[0] ?? null : null
  const loc = selId && snap?.doc ? findClip(snap.doc, selId) : null
  const clip = loc?.clip ?? null
  const kind: 'none' | 'video' | 'text' | 'audio' =
    !clip ? 'none' : clip.kind === 'text' || clip.kind === 'title' ? 'text' : clip.kind === 'audio' ? 'audio' : 'video'

  const [panel, setPanel] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => setPanel(null), [selId]) // reset the open child panel when selection changes
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(t)
  }, [toast])

  const engine = getSharedEngine()
  const dispatch = (cmd: ReturnType<typeof C.setClipSpeed>): void => void engine?.dispatch(cmd)
  const soon = (what: string): void => setToast(`${what} — coming soon`)

  const toastEl = toast ? <div className="mt-toast">{toast}</div> : null

  // ---- nothing selected: the home dock ----
  if (kind === 'none' || !clip) {
    return (
      <div className="mt-dock">
        {toastEl}
        <div className="mt-home">
          <button className="mt-home-btn" onClick={onImport}>
            <Icon name="import" size={18} /> Import media
          </button>
          <button className="mt-home-btn accent" onClick={onCutlord}>
            <Icon name="cutlord" size={18} /> Cut Lord
          </button>
        </div>
      </div>
    )
  }

  const m = clip.metadata ?? {}

  // ---- a child panel is open ----
  if (panel) {
    const back = (
      <button className="mt-back" onClick={() => setPanel(null)}>
        <Icon name="back" size={18} />
      </button>
    )
    let title = panel
    let body: JSX.Element | null = null
    if (panel === 'speed') {
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
    } else if (panel === 'crop') {
      title = 'Crop'
      const cr = clip.crop
      const setCrop = (p: { left?: number; right?: number; top?: number; bottom?: number }): void => void engine?.dispatch(C.setOverlayCrop(clip.id, p))
      body = (
        <>
          <SliderRow label="Left" value={cr.left} min={0} max={0.9} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setCrop({ left: v })} />
          <SliderRow label="Right" value={cr.right} min={0} max={0.9} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setCrop({ right: v })} />
          <SliderRow label="Top" value={cr.top} min={0} max={0.9} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setCrop({ top: v })} />
          <SliderRow label="Bottom" value={cr.bottom} min={0} max={0.9} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setCrop({ bottom: v })} />
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

  // ---- quick actions shared by every selected clip ----
  const quick = (
    <div className="mt-quick">
      <button onClick={() => soon('Replace')} title="Replace"><Icon name="replace" size={18} /></button>
      <button onClick={() => soon('Lock')} title="Lock"><Icon name="lock" size={18} /></button>
      <button onClick={() => engine?.duplicateSelection()} title="Duplicate"><Icon name="duplicate" size={18} /></button>
      <button className="danger" onClick={() => engine?.deleteSelection(true)} title="Delete"><Icon name="trash" size={18} /></button>
      <button onClick={() => soon('More')} title="More"><Icon name="more" size={18} /></button>
    </div>
  )

  // ---- text clip toolbar ----
  if (kind === 'text') {
    return (
      <div className="mt-dock">
        {toastEl}
        {quick}
        <div className="mt-row">
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
          <Tool icon="volume" label="Volume" onClick={() => setPanel('volume')} />
          <Tool icon="speed" label="Speed" onClick={() => setPanel('speed')} />
          <Tool icon="split" label="Split" onClick={() => engine?.splitAtPlayhead()} />
          <Tool icon="music" label="Fade" onClick={() => soon('Fade')} />
          <Tool icon="trash" label="Delete" onClick={() => engine?.deleteSelection(true)} />
        </div>
      </div>
    )
  }

  // ---- video / overlay clip toolbar ----
  const canDetach = clip.hasAudio && !clip.audioDetached
  const durSec = snap ? framesToSeconds(clip.duration, snap.doc.timebase) : 0
  return (
    <div className="mt-dock">
      {toastEl}
      {quick}
      <div className="mt-row">
        <Tool icon="split" label="Split" onClick={() => engine?.splitAtPlayhead()} />
        <Tool icon="overlay" label="Overlay" onClick={() => void useStore.getState().importOverlayFromDevice()} />
        <Tool icon="speed" label="Speed" onClick={() => setPanel('speed')} />
        <Tool icon="zoom" label="Zoom" onClick={() => setPanel('zoom')} />
        <Tool icon="crop" label="Crop" onClick={() => setPanel('crop')} />
        <Tool icon="adjust" label="Adjust" onClick={() => setPanel('adjust')} />
        <Tool icon="volume" label="Volume" onClick={() => setPanel('volume')} />
        <Tool icon="animation" label="Animation" onClick={() => setPanel('animation')} />
        <Tool icon="audioExtract" label="Extract" onClick={() => (canDetach ? engine?.dispatch(C.detachAudio(clip.id)) : soon('Audio already on a lane'))} />
        <Tool icon="removeBg" label="Remove BG" onClick={() => soon('Remove BG')} />
      </div>
      <div className="mt-dur">{durSec.toFixed(1)}s</div>
    </div>
  )
}
