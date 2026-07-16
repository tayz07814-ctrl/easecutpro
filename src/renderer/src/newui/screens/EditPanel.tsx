// Edit tab — a contextual properties inspector for whatever's selected on the
// timeline / preview. Reads the shared engine's selection and edits the SAME
// document the preview + export read (via undoable engine commands), or the
// project's text overlays (updateText). Every control is a slider + a typed
// numeric box, matching the reference inspector.
//
// Supported today (mapped to the real data model):
//   • video / image clip  — Scale, Crop, Zoom (Ken Burns), Speed, Volume
//   • audio clip          — Volume, Speed
//   • text / caption      — content, size, bold/italic/outline, colour, align,
//                           position, Stroke, Background
// Not yet in the model (would need renderer + export work): text rotate /
// opacity / glow / shadow / curve, and "save as preset".

import { useState } from 'react'
import type { ReactNode } from 'react'
import { css } from '../css'
import { useSharedEngineSnapshot, getSharedEngine } from '../../timelineEngine'
import * as C from '@shared/timeline/commands'
import type { Clip as DocClip, Track, TextContent } from '@shared/timeline/types'

const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const mnum = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)

const LABEL = 'font-size:10px;font-weight:700;letter-spacing:.07em;color:#686E7B;text-transform:uppercase;margin:18px 0 4px'
const FIELD = 'width:56px;background:#1E2026;border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:5px 7px;color:#E9EAEE;font-size:12px;font-family:inherit;text-align:right;outline:none'

// Slider + numeric box + unit. `value`/`min`/`max` are in DISPLAY units (e.g.
// percent); onChange returns the display number.
function Row({ label, value, min, max, step = 1, unit = '', onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void
}): JSX.Element {
  return (
    <div style={css('display:flex;align-items:center;gap:10px;margin-top:11px')}>
      <div style={css('width:46px;flex:none;font-size:11.5px;color:#9BA0AC')}>{label}</div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(clampN(Number(e.target.value), min, max))} style={css('flex:1;min-width:0;accent-color:#6E6AE8')} />
      <input type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(clampN(Number(e.target.value), min, max))} style={css(FIELD)} />
      {unit && <span style={css('width:12px;flex:none;font-size:11px;color:#686E7B')}>{unit}</span>}
    </div>
  )
}

// Two numeric boxes on one row (e.g. Position X / Y).
function PairRow({ label, ax, ay, min, max, step = 1, unit = '', onX, onY }: {
  label: string; ax: number; ay: number; min: number; max: number; step?: number; unit?: string; onX: (v: number) => void; onY: (v: number) => void
}): JSX.Element {
  const box = (v: number, on: (n: number) => void, tag: string): JSX.Element => (
    <div style={css('display:flex;align-items:center;gap:5px')}>
      <span style={css('font-size:11px;color:#686E7B')}>{tag}</span>
      <input type="number" min={min} max={max} step={step} value={v} onChange={(e) => on(clampN(Number(e.target.value), min, max))} style={css(FIELD)} />
      {unit && <span style={css('font-size:11px;color:#686E7B')}>{unit}</span>}
    </div>
  )
  return (
    <div style={css('display:flex;align-items:center;gap:12px;margin-top:11px')}>
      <div style={css('width:46px;flex:none;font-size:11.5px;color:#9BA0AC')}>{label}</div>
      {box(ax, onX, 'X')}
      {box(ay, onY, 'Y')}
    </div>
  )
}

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }): JSX.Element {
  return (
    <button onClick={onClick} style={css(`flex:1;text-align:center;border-radius:8px;padding:7px 0;font-family:inherit;font-size:12px;cursor:pointer;border:1px solid ${on ? '#6E6AE8' : 'rgba(255,255,255,.08)'};background:${on ? 'rgba(110,106,232,.16)' : '#1E2026'};color:${on ? '#B7B5F4' : '#C6C9D2'}`)}>{label}</button>
  )
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }): JSX.Element {
  return (
    <div onClick={onClick} style={css(`width:32px;height:18px;border-radius:9px;flex:none;cursor:pointer;position:relative;background:${on ? '#6E6AE8' : '#3A3E48'}`)}>
      <div style={css(`position:absolute;top:2px;width:14px;height:14px;border-radius:50%;background:${on ? '#fff' : '#9BA0AC'};${on ? 'right:2px' : 'left:2px'}`)} />
    </div>
  )
}

// Collapsible section with an optional enable toggle on the header.
function Section({ title, open, onToggleOpen, enabled, onToggleEnabled, children }: {
  title: string; open: boolean; onToggleOpen: () => void; enabled?: boolean; onToggleEnabled?: () => void; children: ReactNode
}): JSX.Element {
  return (
    <div style={css('margin-top:14px;border-top:1px solid rgba(255,255,255,.06);padding-top:12px')}>
      <div style={css('display:flex;align-items:center;gap:9px')}>
        {onToggleEnabled && <Toggle on={!!enabled} onClick={onToggleEnabled} />}
        <div onClick={onToggleOpen} style={css('flex:1;font-size:12.5px;font-weight:600;color:#E9EAEE;cursor:pointer')}>{title}</div>
        <div onClick={onToggleOpen} style={css('font-size:11px;color:#686E7B;cursor:pointer')}>{open ? '▾' : '▸'}</div>
      </div>
      {open && <div style={css('margin-top:4px')}>{children}</div>}
    </div>
  )
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <div style={css('display:flex;align-items:center;gap:10px;margin-top:11px')}>
      <div style={css('flex:1;font-size:11.5px;color:#9BA0AC')}>{label}</div>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} style={css('width:38px;height:26px;border:none;background:none;padding:0;cursor:pointer')} />
    </div>
  )
}

function EmptyHint(): JSX.Element {
  return (
    <div style={css('flex:1;min-height:0;display:grid;place-items:center;padding:24px;text-align:center')}>
      <div style={css('font-size:12.5px;color:#686E7B;line-height:1.6;max-width:210px')}>Select a clip, audio, text or overlay on the timeline or preview to edit its settings here.</div>
    </div>
  )
}

// ---- clip (video / image / audio) ----
function ClipControls({ clip, isMain }: { clip: DocClip; isMain: boolean }): JSX.Element {
  const m = clip.metadata ?? {}
  const isAudio = clip.kind === 'audio'
  const hasAudio = clip.hasAudio && !clip.audioDetached
  const place = (patch: { ovX?: number; ovY?: number; ovScale?: number; ovZoomStart?: number; ovZoomEnd?: number }): void =>
    void getSharedEngine()?.dispatch(C.setOverlayPlacement(clip.id, patch))
  const crop = (patch: { left?: number; top?: number; right?: number; bottom?: number }): void =>
    void getSharedEngine()?.dispatch(C.setOverlayCrop(clip.id, patch))
  const speed = (v: number): void => void getSharedEngine()?.dispatch(C.setClipSpeed(clip.id, clampN(v, 0.25, 4)))
  const gain = (pct: number): void => void getSharedEngine()?.dispatch(C.setClipGain(clip.id, clampN(pct / 100, 0, 2)))
  const [cropOpen, setCropOpen] = useState(false)

  return (
    <div style={css('flex:1;min-height:0;overflow-y:auto;padding:2px 16px 20px')}>
      <div style={css('font-size:13px;font-weight:650;color:#E9EAEE;margin-top:14px')}>{isAudio ? 'Audio clip' : isMain ? 'Video clip' : 'Overlay'}</div>
      <div style={css('font-size:11px;color:#686E7B;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{clip.name}</div>

      {!isAudio && (
        <>
          <div style={css(LABEL)}>Transform</div>
          <Row label="Scale" value={Math.round(mnum(m.ovScale, isMain ? 1 : 0.45) * 100)} min={isMain ? 10 : 5} max={isMain ? 300 : 160} unit="%"
            onChange={(v) => place({ ovScale: v / 100 })} />
          <PairRow label={isMain ? 'Pan' : 'Position'} ax={Math.round(mnum(m.ovX, 0) * 100)} ay={Math.round(mnum(m.ovY, 0) * 100)}
            min={isMain ? -50 : -30} max={isMain ? 50 : 130} unit="%" onX={(v) => place({ ovX: v / 100 })} onY={(v) => place({ ovY: v / 100 })} />

          <Section title="Crop" open={cropOpen} onToggleOpen={() => setCropOpen((o) => !o)}>
            {([['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']] as const).map(([k, l]) => (
              <Row key={k} label={l} value={Math.round(clip.crop[k] * 100)} min={0} max={90} unit="%" onChange={(v) => crop({ [k]: clampN(v / 100, 0, 0.9) })} />
            ))}
          </Section>

          <div style={css(LABEL)}>Zoom (Ken Burns)</div>
          <Row label="Start" value={Math.round(mnum(m.ovZoomStart, 1) * 100)} min={100} max={400} step={5} unit="%" onChange={(v) => place({ ovZoomStart: v / 100 })} />
          <Row label="End" value={Math.round(mnum(m.ovZoomEnd, 1) * 100)} min={100} max={400} step={5} unit="%" onChange={(v) => place({ ovZoomEnd: v / 100 })} />
        </>
      )}

      <div style={css(LABEL)}>Playback</div>
      <Row label="Speed" value={Number((clip.speed ?? 1).toFixed(2))} min={0.25} max={4} step={0.05} unit="×" onChange={speed} />
      {(isAudio || hasAudio) && (
        <Row label="Volume" value={Math.round((clip.gain ?? 1) * 100)} min={0} max={200} step={5} unit="%" onChange={gain} />
      )}

      <div style={css('display:flex;gap:8px;margin-top:18px')}>
        <button onClick={() => getSharedEngine()?.splitAtPlayhead()} style={css('flex:1;background:#1E2026;border:1px solid rgba(255,255,255,.1);color:#C6C9D2;font-family:inherit;font-size:12px;border-radius:9px;padding:8px 0;cursor:pointer')}>Split</button>
        <button onClick={() => getSharedEngine()?.deleteSelection(isMain)} style={css('flex:1;background:none;border:1px solid rgba(217,104,110,.4);color:#D9868B;font-family:inherit;font-size:12px;border-radius:9px;padding:8px 0;cursor:pointer')}>Delete</button>
      </div>
    </div>
  )
}

// ---- text / caption (document text clip) ----
function DocTextControls({ clip }: { clip: DocClip }): JSX.Element {
  const t = clip.text as TextContent
  const isCaption = !!clip.metadata?.caption
  const setC = (patch: Partial<TextContent>): void => void getSharedEngine()?.dispatch(C.setClipText(clip.id, patch))
  const setX = (v: number): void => void getSharedEngine()?.dispatch(C.setClipTransform(clip.id, { x: v / 100 - 0.5 }))
  const setY = (v: number): void => void getSharedEngine()?.dispatch(C.setClipTransform(clip.id, { y: v / 100 - 0.5 }))
  const [strokeOpen, setStrokeOpen] = useState(false)
  const [bgOpen, setBgOpen] = useState(false)
  const bg = t.background

  return (
    <div style={css('flex:1;min-height:0;overflow-y:auto;padding:2px 16px 20px')}>
      <div style={css('font-size:13px;font-weight:650;color:#E9EAEE;margin-top:14px')}>{isCaption ? 'Caption' : 'Text'}</div>

      <div style={css(LABEL)}>Content</div>
      <textarea value={t.text} onChange={(e) => setC({ text: e.target.value })} rows={2} style={css('width:100%;box-sizing:border-box;resize:none;background:#1E2026;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px 10px;color:#E9EAEE;font-size:12.5px;font-family:inherit;outline:none;margin-top:4px')} />

      <div style={css('display:flex;gap:8px;margin-top:12px')}>
        <Chip label="Bold" on={t.bold} onClick={() => setC({ bold: !t.bold })} />
        <Chip label="Italic" on={t.italic} onClick={() => setC({ italic: !t.italic })} />
        <Chip label="Outline" on={t.strokeWidth > 0} onClick={() => setC({ strokeWidth: t.strokeWidth > 0 ? 0 : 0.08 })} />
      </div>
      <div style={css('display:flex;gap:8px;margin-top:8px')}>
        {(['left', 'center', 'right'] as const).map((a) => (
          <Chip key={a} label={a[0].toUpperCase() + a.slice(1)} on={t.align === a} onClick={() => setC({ align: a })} />
        ))}
      </div>

      <Row label="Size" value={Math.round(t.fontSize * 100)} min={2} max={40} unit="" onChange={(v) => setC({ fontSize: v / 100 })} />
      <ColorField label="Colour" value={t.color} onChange={(v) => setC({ color: v })} />
      <PairRow label="Position" ax={Math.round((0.5 + clip.transform.x.static) * 100)} ay={Math.round((0.5 + clip.transform.y.static) * 100)} min={0} max={100} unit="%" onX={setX} onY={setY} />

      <Section title="Outline" open={strokeOpen} onToggleOpen={() => setStrokeOpen((o) => !o)} enabled={t.strokeWidth > 0} onToggleEnabled={() => setC({ strokeWidth: t.strokeWidth > 0 ? 0 : 0.08 })}>
        <Row label="Width" value={Math.round(t.strokeWidth * 100)} min={0} max={40} unit="" onChange={(v) => setC({ strokeWidth: v / 100 })} />
        <ColorField label="Colour" value={t.strokeColor} onChange={(v) => setC({ strokeColor: v })} />
      </Section>

      <Section title="Background" open={bgOpen} onToggleOpen={() => setBgOpen((o) => !o)} enabled={bg.enabled} onToggleEnabled={() => setC({ background: { ...bg, enabled: !bg.enabled } })}>
        <ColorField label="Colour" value={bg.color} onChange={(v) => setC({ background: { ...bg, color: v } })} />
        <Row label="Opacity" value={Math.round(bg.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => setC({ background: { ...bg, opacity: v / 100 } })} />
        <Row label="Radius" value={Math.round(bg.radius * 100)} min={0} max={100} unit="" onChange={(v) => setC({ background: { ...bg, radius: v / 100 } })} />
        <Row label="Padding" value={Math.round(bg.padding * 100)} min={0} max={100} unit="" onChange={(v) => setC({ background: { ...bg, padding: v / 100 } })} />
      </Section>

      <button onClick={() => getSharedEngine()?.deleteSelection(false)} style={css('width:100%;margin-top:18px;background:none;border:1px solid rgba(217,104,110,.4);color:#D9868B;font-family:inherit;font-size:12px;border-radius:9px;padding:8px 0;cursor:pointer')}>Delete text</button>
    </div>
  )
}

export default function EditPanel(): JSX.Element {
  const snap = useSharedEngineSnapshot()
  // Selection lives in the engine (the timeline + preview publish it there).
  const engineSel = snap?.interaction.selection[0] ?? null
  let selClip: DocClip | null = null
  let selTrack: Track | null = null
  if (engineSel && snap?.doc) {
    for (const tr of snap.doc.tracks) {
      const c = tr.clips.find((cl) => cl.id === engineSel)
      if (c) { selClip = c; selTrack = tr; break }
    }
  }

  if (selClip && selClip.kind === 'text' && selClip.text) return <DocTextControls clip={selClip} />
  if (selClip) return <ClipControls clip={selClip} isMain={!!selTrack?.isMain} />
  return <EmptyHint />
}
