import type { TextClip } from '@shared/types'

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rad = Math.max(0, Math.min(r, h / 2, w / 2))
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

function rgba(hex: string, opacity: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity})`
}

export function fontString(clip: TextClip, fontPx: number): string {
  // 800 (not 700) so bold text reads as a heavy CAPTION weight everywhere — on
  // phones the desktop 'Arial Black' etc. fall back to the system sans, and 700
  // looked thin/inconsistent vs desktop. Matches TextLayer (preview == export).
  const weight = clip.bold ? '800 ' : '400 '
  const style = clip.italic ? 'italic ' : ''
  return `${style}${weight}${fontPx}px "${clip.fontFamily}", sans-serif`
}

/**
 * Draws a text clip onto a canvas context at frame size W×H. Used both to bake
 * the export PNG and (optionally) to preview. Background hugs each line with
 * rounded corners (CapCut-style), with adjustable stroke.
 */
export function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: TextClip,
  W: number,
  H: number
): void {
  const fontPx = Math.max(8, clip.fontSize * H)
  ctx.font = fontString(clip, fontPx)
  ctx.textBaseline = 'middle'

  const lines = clip.text.length ? clip.text.split('\n') : [' ']
  const padX = clip.bgPadding * fontPx
  const radius = clip.bgRadius * fontPx
  const strokePx = clip.strokeWidth * fontPx
  // line-height = bg box height so per-line backgrounds touch (join) instead of overlap.
  const lineHeight = clip.bgEnabled ? fontPx * (1 + 1.4 * clip.bgPadding) : fontPx * 1.3

  const widths = lines.map((l) => ctx.measureText(l || ' ').width)
  const maxW = Math.max(...widths, 1)
  const blockH = lines.length * lineHeight
  const cx = clip.x * W
  const cy = clip.y * H
  const topY = cy - blockH / 2

  const lineLeft = (i: number): number => {
    if (clip.align === 'center') return cx - widths[i] / 2
    if (clip.align === 'right') return cx + maxW / 2 - widths[i]
    return cx - maxW / 2
  }

  // 1) Backgrounds (hug each line; boxes are line-height tall so they join).
  if (clip.bgEnabled) {
    ctx.fillStyle = rgba(clip.bgColor, clip.bgOpacity)
    lines.forEach((line, i) => {
      if (!line.trim()) return
      const lc = topY + i * lineHeight + lineHeight / 2
      const w = widths[i] + padX * 2
      roundRectPath(ctx, lineLeft(i) - padX, lc - lineHeight / 2, w, lineHeight, radius)
      ctx.fill()
    })
  }

  // 2) Text (stroke under fill).
  ctx.textAlign = 'left'
  lines.forEach((line, i) => {
    const lc = topY + i * lineHeight + lineHeight / 2
    if (strokePx > 0) {
      ctx.lineJoin = 'round'
      ctx.strokeStyle = clip.strokeColor
      ctx.lineWidth = strokePx * 2
      ctx.strokeText(line, lineLeft(i), lc)
    }
    ctx.fillStyle = clip.color
    ctx.fillText(line, lineLeft(i), lc)
  })
}

/** Render a text clip to a full-frame transparent PNG data URL (for export overlay). */
export function renderTextPng(clip: TextClip, W: number, H: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(W))
  canvas.height = Math.max(2, Math.round(H))
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  drawTextClip(ctx, clip, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}
