import { useState } from 'react'
import { useStore } from '../store'
import { useSharedEngineSnapshot, getSharedEngine } from '../timelineEngine'
import { secondsToFrames } from '@shared/timeline/time'
import { mainTrackId } from '@shared/timeline/model'
import * as C from '@shared/timeline/commands'
import type { TextClip } from '@shared/types'
import type { TimelineDocument } from '@shared/timeline/types'

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** Flat descriptor the text renderer consumes (same whether legacy or document). */
interface TextView {
  id: string
  text: string
  x: number // centre fraction 0..1
  y: number
  fontFamily: string
  fontSize: number
  color: string
  align: 'left' | 'center' | 'right'
  bold: boolean
  italic: boolean
  strokeWidth: number
  strokeColor: string
  bgEnabled: boolean
  bgColor: string
  bgOpacity: number
  bgRadius: number
  bgPadding: number
}

function rgba(hex: string, opacity: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity})`
}

function fromLegacy(t: TextClip): TextView {
  return { ...t }
}

function docTexts(doc: TimelineDocument, playheadSec: number): TextView[] {
  const ph = secondsToFrames(playheadSec, doc.timebase)
  const mainId = mainTrackId(doc)
  const out: TextView[] = []
  for (const tr of doc.tracks) {
    if (tr.kind !== 'text' || tr.id === mainId || tr.hidden) continue
    for (const c of tr.clips) {
      if (!c.text) continue
      if (ph < c.start || ph >= c.end) continue
      const t = c.text
      out.push({
        id: c.id,
        text: t.text,
        x: 0.5 + c.transform.x.static,
        y: 0.5 + c.transform.y.static,
        fontFamily: t.fontFamily,
        fontSize: t.fontSize,
        color: t.color,
        align: t.align,
        bold: t.bold,
        italic: t.italic,
        strokeWidth: t.strokeWidth,
        strokeColor: t.strokeColor,
        bgEnabled: t.background.enabled,
        bgColor: t.background.color,
        bgOpacity: t.background.opacity,
        bgRadius: t.background.radius,
        bgPadding: t.background.padding
      })
    }
  }
  return out
}

/** Renders on-screen text overlays over the preview frame (document or legacy). */
export default function TextLayer({ frame }: { frame: Rect }): JSX.Element {
  const project = useStore((s) => s.project)
  const playhead = project.playhead
  const selectedTextId = useStore((s) => s.selectedTextId)
  const selectText = useStore((s) => s.selectText)
  const updateText = useStore((s) => s.updateText)
  const snap = useSharedEngineSnapshot()
  const docMode = !!project.timeline && !!snap?.doc

  const active: TextView[] = docMode
    ? docTexts(snap!.doc, playhead)
    : (project.texts ?? []).filter((t) => playhead >= t.start && playhead < t.end).map(fromLegacy)

  const commit = (id: string, patch: { x: number; y: number }): void => {
    if (docMode) getSharedEngine()?.dispatch(C.setClipTransform(id, { x: patch.x - 0.5, y: patch.y - 0.5 }))
    else updateText(id, patch)
  }
  const select = (id: string): void => {
    if (docMode) getSharedEngine()?.select([id])
    else selectText(id)
  }
  const selId = docMode ? snap!.interaction.selection[0] ?? null : selectedTextId

  return (
    <div className="text-layer" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}>
      {active.map((t) => (
        <TextItem key={t.id} view={t} frame={frame} selected={selId === t.id} onCommit={commit} onSelect={select} />
      ))}
    </div>
  )
}

function TextItem({
  view,
  frame,
  selected,
  onCommit,
  onSelect
}: {
  view: TextView
  frame: Rect
  selected: boolean
  onCommit: (id: string, patch: { x: number; y: number }) => void
  onSelect: (id: string) => void
}): JSX.Element {
  const [live, setLive] = useState<{ x: number; y: number } | null>(null)
  const x = live?.x ?? view.x
  const y = live?.y ?? view.y

  const fontPx = view.fontSize * frame.height
  const strokePx = view.strokeWidth * fontPx
  const padX = view.bgPadding * fontPx
  const padY = view.bgPadding * fontPx * 0.7
  const radius = view.bgRadius * fontPx
  const lineHeight = view.bgEnabled ? 1 + 1.4 * view.bgPadding : 1.3

  function startMove(e: React.MouseEvent): void {
    e.stopPropagation()
    onSelect(view.id)
    const sx = e.clientX
    const sy = e.clientY
    const x0 = view.x
    const y0 = view.y
    let nx = x0
    let ny = y0
    function onMove(ev: MouseEvent): void {
      nx = Math.min(1.1, Math.max(-0.1, x0 + (ev.clientX - sx) / frame.width))
      ny = Math.min(1.1, Math.max(-0.1, y0 + (ev.clientY - sy) / frame.height))
      setLive({ x: nx, y: ny })
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setLive(null)
      onCommit(view.id, { x: nx, y: ny })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={'text-item' + (selected ? ' selected' : '')}
      style={{ left: x * frame.width, top: y * frame.height, transform: 'translate(-50%, -50%)', textAlign: view.align }}
      onPointerDown={startMove}
    >
      <span
        style={{
          fontFamily: `"${view.fontFamily}", sans-serif`,
          fontSize: fontPx,
          fontWeight: view.bold ? 700 : 400,
          fontStyle: view.italic ? 'italic' : 'normal',
          lineHeight: lineHeight,
          color: view.color,
          whiteSpace: 'pre',
          WebkitTextStrokeWidth: strokePx > 0 ? `${strokePx}px` : undefined,
          WebkitTextStrokeColor: strokePx > 0 ? view.strokeColor : undefined,
          paintOrder: 'stroke fill',
          background: view.bgEnabled ? rgba(view.bgColor, view.bgOpacity) : undefined,
          padding: view.bgEnabled ? `${padY}px ${padX}px` : undefined,
          borderRadius: view.bgEnabled ? radius : undefined,
          WebkitBoxDecorationBreak: 'clone',
          boxDecorationBreak: 'clone'
        }}
      >
        {view.text}
      </span>
    </div>
  )
}
