// Shared preview gesture for overlay boxes and text items:
//   • ONE finger / mouse  = move, with the element's CENTRE snapping to the
//     frame's vertical + horizontal centre lines.
//   • TWO fingers         = pinch-resize.
// The position anchor differs (overlays are top-left anchored, text is centre
// anchored), so callers pass `half(scale)` — the box half-size in frame
// fractions — and the snap math works for both. Values are reported live during
// the gesture and committed once when the last pointer lifts.
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

export interface PinchDragCfg {
  frame: { width: number; height: number }
  /** committed x/y (position anchor, frame fraction) + scale at gesture start */
  start: () => { x: number; y: number; scale: number }
  /** box half-width/height in frame fractions for a given scale (centre = pos + half) */
  half: (scale: number) => { hw: number; hh: number }
  scaleRange: [number, number]
  xRange: [number, number]
  yRange: [number, number]
  onSelect: () => void
  onLive: (p: { x: number; y: number; scale: number }) => void
  onCommit: (p: { x: number; y: number; scale: number }) => void
  onSnap: (s: { v: boolean; h: boolean }) => void
}

const SNAP = 0.018 // snap when the centre is within ~1.8% of a frame centre line
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

interface GState {
  ptrs: Map<number, { x: number; y: number }>
  mode: 'move' | 'pinch'
  x0: number
  y0: number
  s0: number
  px0: number
  py0: number
  d0: number
  nx: number
  ny: number
  ns: number
}

export function usePinchDrag(cfg: PinchDragCfg): (e: ReactPointerEvent) => void {
  // Latest cfg via a ref so the stable move/up handlers always read fresh values.
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const g = useRef<GState | null>(null)
  const move = useRef<(ev: PointerEvent) => void>()
  const up = useRef<(ev: PointerEvent) => void>()

  if (!move.current) {
    move.current = (ev: PointerEvent): void => {
      const c = cfgRef.current
      const s = g.current
      if (!s) return
      if (s.ptrs.has(ev.pointerId)) s.ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
      const pts = [...s.ptrs.values()]
      if (s.mode === 'pinch' && pts.length >= 2) {
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
        s.ns = clamp(s.s0 * (d / (s.d0 || d)), c.scaleRange[0], c.scaleRange[1])
        c.onLive({ x: s.nx, y: s.ny, scale: s.ns })
        c.onSnap({ v: false, h: false })
      } else if (s.mode === 'move') {
        let nx = clamp(s.x0 + (ev.clientX - s.px0) / c.frame.width, c.xRange[0], c.xRange[1])
        let ny = clamp(s.y0 + (ev.clientY - s.py0) / c.frame.height, c.yRange[0], c.yRange[1])
        const { hw, hh } = c.half(s.ns)
        const v = Math.abs(nx + hw - 0.5) < SNAP
        const h = Math.abs(ny + hh - 0.5) < SNAP
        if (v) nx = 0.5 - hw
        if (h) ny = 0.5 - hh
        s.nx = nx
        s.ny = ny
        c.onLive({ x: nx, y: ny, scale: s.ns })
        c.onSnap({ v, h })
      }
    }
    up.current = (ev: PointerEvent): void => {
      const c = cfgRef.current
      const s = g.current
      if (!s) return
      s.ptrs.delete(ev.pointerId)
      if (s.ptrs.size > 0) {
        // dropped from two fingers to one — keep moving from the survivor
        const p = [...s.ptrs.values()][0]
        s.mode = 'move'
        s.px0 = p.x
        s.py0 = p.y
        s.x0 = s.nx
        s.y0 = s.ny
        return
      }
      window.removeEventListener('pointermove', move.current!)
      window.removeEventListener('pointerup', up.current!)
      window.removeEventListener('pointercancel', up.current!)
      g.current = null
      c.onSnap({ v: false, h: false })
      c.onCommit({ x: s.nx, y: s.ny, scale: s.ns })
    }
  }

  return (e: ReactPointerEvent): void => {
    e.stopPropagation()
    cfgRef.current.onSelect()
    let s = g.current
    if (!s) {
      const st = cfgRef.current.start()
      s = { ptrs: new Map(), mode: 'move', x0: st.x, y0: st.y, s0: st.scale, px0: e.clientX, py0: e.clientY, d0: 0, nx: st.x, ny: st.y, ns: st.scale }
      g.current = s
      window.addEventListener('pointermove', move.current!)
      window.addEventListener('pointerup', up.current!)
      window.addEventListener('pointercancel', up.current!)
    }
    s.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...s.ptrs.values()]
    if (pts.length >= 2) {
      s.mode = 'pinch'
      s.d0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      s.s0 = s.ns
    } else {
      s.mode = 'move'
      s.px0 = e.clientX
      s.py0 = e.clientY
      s.x0 = s.nx
      s.y0 = s.ny
    }
  }
}
