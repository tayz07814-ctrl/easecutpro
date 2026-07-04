// Canvas waveform: draws normalized peaks (0..1) as a filled, mirrored ENVELOPE —
// a continuous ridge that rises into MOUNTAINS at loud speech and drops to flat
// VALLEYS at silence, so pauses are obvious at a glance. Sized to its container
// via ResizeObserver so it stays crisp while clips resize with zoom. DPR-aware.
// The peak DATA comes from the media-data provider; this file is purely the renderer.

import { useEffect, useRef } from 'react'

// Teal palette (bright ridge, softer glow toward the centre baseline).
const RIDGE = 'rgba(122, 248, 232, 0.95)'
const FILL_EDGE = 'rgba(56, 226, 210, 0.30)'
const FILL_CORE = 'rgba(96, 244, 224, 0.60)'

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
  const amp = h / 2 - 1

  // One envelope value per pixel column = max peak over the source range it covers.
  const env = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const from = Math.floor((x / w) * n)
    const to = Math.max(from + 1, Math.floor(((x + 1) / w) * n))
    let p = 0
    for (let j = from; j < to && j < n; j++) if (peaks[j] > p) p = peaks[j]
    env[x] = p
  }
  // 3-tap smoothing so the ridge reads as rolling mountains, not isolated spikes.
  const sm = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const a = env[Math.max(0, x - 1)]
    const b = env[x]
    const c = env[Math.min(w - 1, x + 1)]
    sm[x] = (a + 2 * b + c) / 4
  }
  const yTop = (x: number): number => mid - Math.max(0.5, sm[x] * amp)
  const yBot = (x: number): number => mid + Math.max(0.5, sm[x] * amp)

  // Filled mirrored area (top ridge out, bottom ridge back) with a vertical glow.
  ctx.beginPath()
  ctx.moveTo(0, yTop(0))
  for (let x = 1; x < w; x++) ctx.lineTo(x, yTop(x))
  for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, yBot(x))
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, mid - amp, 0, mid + amp)
  grad.addColorStop(0, FILL_EDGE)
  grad.addColorStop(0.5, FILL_CORE)
  grad.addColorStop(1, FILL_EDGE)
  ctx.fillStyle = grad
  ctx.fill()

  // Crisp ridge line along both envelopes for definition.
  ctx.lineWidth = 1
  ctx.strokeStyle = RIDGE
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(0, yTop(0))
  for (let x = 1; x < w; x++) ctx.lineTo(x, yTop(x))
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(0, yBot(0))
  for (let x = 1; x < w; x++) ctx.lineTo(x, yBot(x))
  ctx.stroke()
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
