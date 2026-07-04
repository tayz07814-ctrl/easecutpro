// Canvas waveform: draws normalized peaks (0..1) as dense, mirrored VERTICAL BARS
// in a bright teal — tall bars pile into MOUNTAINS at loud speech and drop to short
// stubs (VALLEYS) at silence, so pauses are obvious at a glance. Sized to its
// container via ResizeObserver so it stays crisp while clips resize with zoom.
// DPR-aware. The peak DATA comes from the media-data provider; this is the renderer.

import { useEffect, useRef } from 'react'

function paint(canvas: HTMLCanvasElement, peaks: number[]): void {
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

  // Bright-teal vertical gradient so the bar tops read as a glowing ridge line.
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, 'rgba(122, 248, 232, 0.95)')
  grad.addColorStop(0.5, 'rgba(52, 214, 200, 0.7)')
  grad.addColorStop(1, 'rgba(122, 248, 232, 0.95)')
  ctx.fillStyle = grad

  const barW = 2
  const step = 3 // 2px bar + 1px gap → reads as distinct bars, not a solid block
  for (let x = 0; x < w; x += step) {
    // max peak across the source range this bar covers (peaky, CapCut-like)
    const from = Math.floor((x / w) * n)
    const to = Math.max(from + 1, Math.floor(((x + step) / w) * n))
    let p = 0
    for (let j = from; j < to && j < n; j++) if (peaks[j] > p) p = peaks[j]
    const bh = Math.max(1.5, p * amp)
    ctx.fillRect(x, mid - bh / 2, barW, bh)
  }
}

export function WaveformCanvas({ peaks }: { peaks: number[]; color?: string }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const render = (): void => paint(canvas, peaks)
    const ro = new ResizeObserver(render)
    ro.observe(parent)
    render()
    return () => ro.disconnect()
  }, [peaks])
  return <canvas ref={ref} className="ec-tl-wave-canvas" />
}
