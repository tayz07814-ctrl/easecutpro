// Canvas waveform: draws normalized peaks (0..1) as dense, mirrored VERTICAL BARS
// in a bright teal — tall bars pile into MOUNTAINS at loud speech and drop to short
// stubs (VALLEYS) at silence, so pauses are obvious at a glance. DPR-aware.
// The peak DATA comes from the media-data provider; this is the renderer.
//
// ONLY THE VISIBLE SPAN IS RASTERISED. The clip element is as wide as the zoom
// makes it, and the canvas used to be sized to the whole of it — past a few tens
// of thousands of pixels that exceeds the browser's maximum canvas dimension, the
// backing store fails to allocate, and the waveform renders as a solid WHITE BAR
// (what you see when you zoom in far enough). It also meant allocating tens of MB
// of pixels for a strip only a screen wide. The canvas is now sized and positioned
// to the visible window, and peaks are mapped through the element's FULL width, so
// the drawing is identical — it just stops rasterising what nobody can see.

import { useEffect, useRef, useState } from 'react'

/** 3-stop vertical gradient (top / mid / bottom). Default = the bright teal. */
type Grad3 = [string, string, string]
const TEAL: Grad3 = ['rgba(122, 248, 232, 0.95)', 'rgba(52, 214, 200, 0.7)', 'rgba(122, 248, 232, 0.95)']

/** Widest backing store we ever allocate, whatever the zoom. */
const MAX_CANVAS_W = 4096

/** Nearest scrollable ancestor — what decides which part of us is on screen. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let n = el?.parentElement ?? null
  while (n) {
    const o = getComputedStyle(n).overflowX
    if (o === 'auto' || o === 'scroll') return n
    n = n.parentElement
  }
  return null
}

function paint(
  canvas: HTMLCanvasElement,
  peaks: number[],
  colors: Grad3,
  barW: number,
  step: number,
  totalW: number,
  offsetX: number,
  visW: number,
  h: number
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.max(1, Math.round(visW * dpr))
  canvas.height = Math.max(1, Math.round(h * dpr))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, visW, h)
  const n = peaks.length
  if (n === 0 || totalW <= 0) return
  const mid = h / 2
  const amp = h - 2

  // Vertical gradient so the bar tops read as a glowing ridge line.
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, colors[0])
  grad.addColorStop(0.5, colors[1])
  grad.addColorStop(1, colors[2])
  ctx.fillStyle = grad

  for (let x = 0; x < visW; x += step) {
    // Map back through the FULL element width so bars sit exactly where they
    // would have if the whole clip were rasterised.
    const absFrom = offsetX + x
    const absTo = offsetX + x + step
    const from = Math.floor((absFrom / totalW) * n)
    const to = Math.max(from + 1, Math.floor((absTo / totalW) * n))
    let p = 0
    for (let j = from; j < to && j < n; j++) if (j >= 0 && peaks[j] > p) p = peaks[j]
    // Peaks arrive already source-normalized (see clipPeaks); a mild exponent
    // (>1) deepens the valleys so pauses read as clear dips, not a soft ripple.
    p = Math.pow(p, 1.15)
    const bh = Math.max(1.5, p * amp)
    ctx.fillRect(x, mid - bh / 2, barW, bh)
  }
}

/** `colors` (3-stop gradient), `barW` and `step` default to the desktop teal look;
 *  the mobile timeline passes a thin bright-purple variant. */
export function WaveformCanvas({
  peaks,
  colors = TEAL,
  barW = 1,
  step = 2
}: {
  peaks: number[]
  color?: string
  colors?: Grad3
  barW?: number
  step?: number
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState<{ left: number; width: number }>({ left: 0, width: 0 })

  useEffect(() => {
    const canvas = ref.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const sp = scrollParent(parent)
    let raf = 0
    const render = (): void => {
      const totalW = Math.max(1, Math.floor(parent.clientWidth))
      const h = Math.max(1, Math.floor(parent.clientHeight))
      if (totalW <= 1 || h <= 1) return // not laid out yet — try again on the next observation

      // Visible slice of this clip, in its own pixel space, with a screen of
      // margin either side so scrolling reveals ready pixels.
      let offsetX = 0
      let visW = totalW
      if (sp) {
        const a = parent.getBoundingClientRect()
        const b = sp.getBoundingClientRect()
        const margin = b.width
        const left = Math.max(0, b.left - a.left - margin)
        const right = Math.min(totalW, b.right - a.left + margin)
        if (right <= left) {
          setBox({ left: 0, width: 0 })
          return
        }
        offsetX = left
        visW = right - left
      }
      visW = Math.min(visW, MAX_CANVAS_W)
      setBox({ left: offsetX, width: visW })
      paint(canvas, peaks, colors, barW, step, totalW, offsetX, visW, h)
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(render)
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(parent)
    sp?.addEventListener('scroll', schedule, { passive: true })
    render()
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      sp?.removeEventListener('scroll', schedule)
    }
  }, [peaks, colors, barW, step])

  // The class keeps `position: absolute`; only the horizontal box is overridden
  // so the canvas covers just the visible window (right:auto releases inset:0).
  return (
    <canvas
      ref={ref}
      className="ec-tl-wave-canvas"
      style={{ left: box.left, width: box.width, right: 'auto' }}
    />
  )
}
