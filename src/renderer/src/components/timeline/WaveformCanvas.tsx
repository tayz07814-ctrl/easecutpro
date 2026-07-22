// Canvas waveform: draws normalized peaks (0..1) as dense, mirrored VERTICAL BARS
// in a bright teal — tall bars pile into MOUNTAINS at loud speech and drop to short
// stubs (VALLEYS) at silence, so pauses are obvious at a glance. Sized to its
// container via ResizeObserver so it stays crisp while clips resize with zoom.
// DPR-aware. The peak DATA comes from the media-data provider; this is the renderer.

import { useEffect, useRef } from 'react'

/** 3-stop vertical gradient (top / mid / bottom). Default = the bright teal. */
type Grad3 = [string, string, string]
const TEAL: Grad3 = ['rgba(122, 248, 232, 0.95)', 'rgba(52, 214, 200, 0.7)', 'rgba(122, 248, 232, 0.95)']

function paint(canvas: HTMLCanvasElement, peaks: number[], colors: Grad3, barW: number, step: number): void {
  const parent = canvas.parentElement
  if (!parent) return
  const w = Math.max(1, Math.floor(parent.clientWidth))
  const h = Math.max(1, Math.floor(parent.clientHeight))
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const n = peaks.length
  if (n === 0) return
  const mid = h / 2
  const amp = h - 2

  // Vertical gradient so the bar tops read as a glowing ridge line.
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, colors[0])
  grad.addColorStop(0.5, colors[1])
  grad.addColorStop(1, colors[2])
  ctx.fillStyle = grad

  for (let x = 0; x < w; x += step) {
    // max peak across the source range this bar covers (peaky, CapCut-like)
    const from = Math.floor((x / w) * n)
    const to = Math.max(from + 1, Math.floor(((x + step) / w) * n))
    let p = 0
    for (let j = from; j < to && j < n; j++) if (peaks[j] > p) p = peaks[j]
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
  barW = 2,
  step = 3
}: {
  peaks: number[]
  color?: string
  colors?: Grad3
  barW?: number
  step?: number
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const render = (): void => paint(canvas, peaks, colors, barW, step)
    const ro = new ResizeObserver(render)
    ro.observe(parent)
    render()
    return () => ro.disconnect()
  }, [peaks, colors, barW, step])
  return <canvas ref={ref} className="ec-tl-wave-canvas" />
}
