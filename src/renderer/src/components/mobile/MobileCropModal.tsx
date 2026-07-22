// Visual crop tool (0.01) — replaces the four "shit sliders" with a CapCut-style
// crop window: the clip frame with a draggable crop box (corner handles + rule-of
// -thirds grid + dimmed surround) and centred aspect-ratio presets. The engine's
// crop is inset-based (left/right/top/bottom fractions of the source), so the box
// maps straight onto it — Confirm dispatches setOverlayCrop, Cancel just closes.
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getSharedEngine } from '../../timelineEngine'
import { useStore } from '../../store'
import * as C from '@shared/timeline/commands'
import { Icon } from './Icon'
import type { Clip } from '@shared/timeline/types'

const PRESETS: { label: string; ratio: number | null }[] = [
  { label: 'Free', ratio: null },
  { label: '9:16', ratio: 9 / 16 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '2:1', ratio: 2 }
]

const MIN = 0.1 // smallest crop box (fraction of the frame) so it can't collapse
type Box = { l: number; r: number; t: number; b: number }
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

export default function MobileCropModal({ clip, onClose }: { clip: Clip; onClose: () => void }): JSX.Element {
  const library = useStore((s) => s.library)
  const srcAspect = clip.srcW && clip.srcH ? clip.srcW / clip.srcH : 9 / 16
  // Backdrop: the clip's own library thumbnail if we can match it, else any
  // video/image thumbnail (a reference frame). The crop maths work regardless.
  const thumb =
    library.find((it) => it.path === clip.sourcePath)?.thumb ??
    library.find((it) => it.kind === 'video' || it.kind === 'image')?.thumb ??
    null

  const [box, setBox] = useState<Box>({ l: clip.crop.left, r: clip.crop.right, t: clip.crop.top, b: clip.crop.bottom })
  const [preset, setPreset] = useState<string>('Free')
  const frameRef = useRef<HTMLDivElement>(null)

  // pointer fraction inside the displayed frame (0..1), clamped.
  const frac = (e: PointerEvent): { fx: number; fy: number } => {
    const r = frameRef.current?.getBoundingClientRect()
    if (!r) return { fx: 0, fy: 0 }
    return { fx: clamp01((e.clientX - r.left) / r.width), fy: clamp01((e.clientY - r.top) / r.height) }
  }

  const dragCorner = (corner: 'tl' | 'tr' | 'bl' | 'br') => (down: React.PointerEvent): void => {
    down.preventDefault()
    down.stopPropagation()
    setPreset('Free')
    const onMove = (e: PointerEvent): void => {
      const { fx, fy } = frac(e)
      setBox((c) => {
        const n = { ...c }
        if (corner === 'tl' || corner === 'bl') n.l = Math.max(0, Math.min(fx, 1 - c.r - MIN))
        if (corner === 'tr' || corner === 'br') n.r = Math.max(0, Math.min(1 - fx, 1 - c.l - MIN))
        if (corner === 'tl' || corner === 'tr') n.t = Math.max(0, Math.min(fy, 1 - c.b - MIN))
        if (corner === 'bl' || corner === 'br') n.b = Math.max(0, Math.min(1 - fy, 1 - c.t - MIN))
        return n
      })
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

  const dragMove = (down: React.PointerEvent): void => {
    down.preventDefault()
    down.stopPropagation()
    const start = frac(down.nativeEvent)
    const c0 = box
    const onMove = (e: PointerEvent): void => {
      const { fx, fy } = frac(e)
      let dx = fx - start.fx
      let dy = fy - start.fy
      dx = Math.max(-c0.l, Math.min(dx, c0.r))
      dy = Math.max(-c0.t, Math.min(dy, c0.b))
      setBox({ l: c0.l + dx, r: c0.r - dx, t: c0.t + dy, b: c0.b - dy })
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

  const applyPreset = (label: string, ratio: number | null): void => {
    setPreset(label)
    if (ratio == null) return
    // Centre the largest box of the target ratio inside the source frame.
    if (srcAspect <= ratio) {
      const h = srcAspect / ratio
      setBox({ l: 0, r: 0, t: (1 - h) / 2, b: (1 - h) / 2 })
    } else {
      const w = ratio / srcAspect
      setBox({ l: (1 - w) / 2, r: (1 - w) / 2, t: 0, b: 0 })
    }
  }

  const confirm = (): void => {
    void getSharedEngine()?.dispatch(C.setOverlayCrop(clip.id, { left: box.l, right: box.r, top: box.t, bottom: box.b }))
    onClose()
  }

  // crop box geometry as CSS percentages
  const bx = { left: `${box.l * 100}%`, top: `${box.t * 100}%`, right: `${box.r * 100}%`, bottom: `${box.b * 100}%` }
  const handle: React.CSSProperties = { position: 'absolute', width: 26, height: 26, touchAction: 'none' }
  const hInner = (borders: React.CSSProperties): React.CSSProperties => ({ position: 'absolute', width: 18, height: 18, border: '3px solid #fff', ...borders })

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1400, background: '#000', display: 'flex', flexDirection: 'column', userSelect: 'none' }}>
      {/* header */}
      <div style={{ flex: 'none', height: 56, display: 'flex', alignItems: 'center', padding: '0 12px' }}>
        <button onClick={onClose} style={{ width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: '#fff', borderRadius: 10 }}><Icon name="back" size={22} /></button>
        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', fontSize: 16, fontWeight: 600, color: '#fff' }}>Crop</div>
        <button onClick={confirm} style={{ marginLeft: 'auto', width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: '#7ed957', borderRadius: 10 }}><Icon name="check" size={24} /></button>
      </div>

      {/* frame + crop box */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div ref={frameRef} style={{ position: 'relative', aspectRatio: `${srcAspect}`, maxWidth: '100%', maxHeight: '100%', width: 'auto', height: '100%', background: thumb ? `center/cover no-repeat url(${thumb})` : '#111', borderRadius: 2 }}>
          {/* crop box — the giant box-shadow dims everything outside it */}
          <div
            onPointerDown={dragMove}
            style={{ position: 'absolute', ...bx, boxShadow: '0 0 0 9999px rgba(0,0,0,.58)', border: '1.5px solid #fff', touchAction: 'none', cursor: 'move' }}
          >
            {/* rule-of-thirds grid */}
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              <div style={{ position: 'absolute', left: '33.33%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,.4)' }} />
              <div style={{ position: 'absolute', left: '66.66%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,.4)' }} />
              <div style={{ position: 'absolute', top: '33.33%', left: 0, right: 0, height: 1, background: 'rgba(255,255,255,.4)' }} />
              <div style={{ position: 'absolute', top: '66.66%', left: 0, right: 0, height: 1, background: 'rgba(255,255,255,.4)' }} />
            </div>
            {/* corner handles */}
            <div onPointerDown={dragCorner('tl')} style={{ ...handle, left: -13, top: -13, cursor: 'nwse-resize' }}><div style={hInner({ left: 4, top: 4, borderRight: 'none', borderBottom: 'none' })} /></div>
            <div onPointerDown={dragCorner('tr')} style={{ ...handle, right: -13, top: -13, cursor: 'nesw-resize' }}><div style={hInner({ right: 4, top: 4, borderLeft: 'none', borderBottom: 'none' })} /></div>
            <div onPointerDown={dragCorner('bl')} style={{ ...handle, left: -13, bottom: -13, cursor: 'nesw-resize' }}><div style={hInner({ left: 4, bottom: 4, borderRight: 'none', borderTop: 'none' })} /></div>
            <div onPointerDown={dragCorner('br')} style={{ ...handle, right: -13, bottom: -13, cursor: 'nwse-resize' }}><div style={hInner({ right: 4, bottom: 4, borderLeft: 'none', borderTop: 'none' })} /></div>
          </div>
        </div>
      </div>

      {/* aspect-ratio presets */}
      <div style={{ flex: 'none', padding: '4px 12px 2px', color: '#cfcfd4', fontSize: 13 }}>Aspect ratio</div>
      <div style={{ flex: 'none', display: 'flex', gap: 10, padding: '10px 12px', overflowX: 'auto' }}>
        {PRESETS.map((p) => {
          const on = preset === p.label
          return (
            <button key={p.label} onClick={() => applyPreset(p.label, p.ratio)} style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, background: 'none', border: 'none', cursor: 'pointer' }}>
              <span style={{ width: 52, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: on ? 'rgba(164,104,255,.16)' : '#17171b', border: on ? '1.5px solid #a468ff' : '1.5px solid transparent', color: on ? '#c9b3ff' : '#d9d9de', fontSize: 12, fontWeight: 700 }}>
                {p.ratio == null ? <Icon name="crop" size={20} /> : p.label}
              </span>
              <span style={{ fontSize: 11, color: on ? '#c9b3ff' : '#9a9aa0' }}>{p.label}</span>
            </button>
          )
        })}
      </div>

      {/* reset */}
      <div style={{ flex: 'none', padding: '4px 12px calc(env(safe-area-inset-bottom) + 12px)' }}>
        <button onClick={() => { setBox({ l: 0, r: 0, t: 0, b: 0 }); setPreset('Free') }} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid #2a2a30', color: '#cfcfd4', borderRadius: 10, padding: '8px 16px', fontSize: 13, cursor: 'pointer' }}>
          <Icon name="trash" size={16} /> Reset
        </button>
      </div>
    </div>,
    document.body
  )
}
