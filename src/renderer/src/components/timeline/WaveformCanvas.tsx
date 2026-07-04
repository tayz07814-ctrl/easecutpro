// Canvas waveform: draws normalized peaks (0..1) as dense mirrored bars, sized
// to its container via ResizeObserver so it stays crisp while clips resize with
// zoom. DPR-aware. The peak DATA comes from the media-data provider (ffmpeg in
// the app, synthetic in the preview); this file is purely the renderer.

import { useEffect, useRef } from 'react'

function paint(canvas: HTMLCanvasElement, peaks: number[], color: string): void {
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
  ctx.fillStyle = color
  const mid = h / 2
  const step = 2 // 1px bar + 1px gap
  for (let x = 0; x < w; x += step) {
    // max peak across the source range this column covers (peaky, CapCut-like)
    const from = Math.floor((x / w) * n)
    const to = Math.max(from + 1, Math.floor(((x + step) / w) * n))
    let p = 0
    for (let j = from; j < to && j < n; j++) if (peaks[j] > p) p = peaks[j]
    const bh = Math.max(1, p * (h - 2))
    ctx.fillRect(x, mid - bh / 2, 1, bh)
  }
}

export function WaveformCanvas({
  peaks,
  color = 'rgba(255, 255, 255, 0.72)'
}: {
  peaks: number[]
  color?: string
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const render = (): void => paint(canvas, peaks, color)
    const ro = new ResizeObserver(render)
    ro.observe(parent)
    render()
    return () => ro.disconnect()
  }, [peaks, color])
  return <canvas ref={ref} className="ec-tl-wave-canvas" />
}
