import { useState } from 'react'
import { useStore } from '../store'
import { useSharedEngineSnapshot, getSharedEngine } from '../timelineEngine'
import { secondsToFrames } from '@shared/timeline/time'
import { mainTrackId } from '@shared/timeline/model'
import * as C from '@shared/timeline/commands'
import { usePinchDrag } from '../usePinchDrag'
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

  const commit = (id: string, patch: { x?: number; y?: number; fontSize?: number }): void => {
    if (docMode) {
      const e = getSharedEngine()
      if (patch.x !== undefined && patch.y !== undefined) e?.dispatch(C.setClipTransform(id, { x: patch.x - 0.5, y: patch.y - 0.5 }))
      if (patch.fontSize !== undefined) e?.dispatch(C.setClipText(id, { fontSize: patch.fontSize }))
    } else {
      updateText(id, patch)
    }
  }
  const select = (id: string): void => {
    if (docMode) getSharedEngine()?.select([id])
    else selectText(id)
  }
  const selId = docMode ? snap!.interaction.selection[0] ?? null : selectedTextId
  const [guide, setGuide] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })

  return (
    <div className="text-layer" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}>
      {active.map((t) => (
        <TextItem key={t.id} view={t} frame={frame} selected={selId === t.id} onCommit={commit} onSelect={select} onSnap={setGuide} />
      ))}
      {guide.v && <div className="snap-guide-v" />}
      {guide.h && <div className="snap-guide-h" />}
    </div>
  )
}

function TextItem({
  view,
  frame,
  selected,
  onCommit,
  onSelect,
  onSnap
}: {
  view: TextView
  frame: Rect
  selected: boolean
  onCommit: (id: string, patch: { x?: number; y?: number; fontSize?: number }) => void
  onSelect: (id: string) => void
  onSnap: (s: { v: boolean; h: boolean }) => void
}): JSX.Element {
  const [live, setLive] = useState<{ x?: number; y?: number; fontSize?: number } | null>(null)
  const x = live?.x ?? view.x
  const y = live?.y ?? view.y
  const fontSize = live?.fontSize ?? view.fontSize

  const fontPx = fontSize * frame.height
  const strokePx = view.strokeWidth * fontPx
  const padX = view.bgPadding * fontPx
  const padY = view.bgPadding * fontPx * 0.7
  const radius = view.bgRadius * fontPx
  const lineHeight = view.bgEnabled ? 1 + 1.4 * view.bgPadding : 1.3

  // One finger = move (centre snaps to the frame's centre lines); two fingers =
  // pinch to resize the font. Text is centre-anchored, so its half-size is 0.
  const onPointerDown = usePinchDrag({
    frame,
    start: () => ({ x: view.x, y: view.y, scale: view.fontSize }),
    half: () => ({ hw: 0, hh: 0 }),
    scaleRange: [0.02, 0.6],
    xRange: [-0.1, 1.1],
    yRange: [-0.1, 1.1],
    onSelect: () => onSelect(view.id),
    onLive: (p) => setLive({ x: p.x, y: p.y, fontSize: p.scale }),
    onCommit: (p) => {
      setLive(null)
      const patch: { x?: number; y?: number; fontSize?: number } = {}
      if (Math.abs(p.x - view.x) > 1e-4 || Math.abs(p.y - view.y) > 1e-4) {
        patch.x = p.x
        patch.y = p.y
      }
      if (Math.abs(p.scale - view.fontSize) > 1e-4) patch.fontSize = p.scale
      if (patch.x !== undefined || patch.fontSize !== undefined) onCommit(view.id, patch)
    },
    onSnap
  })

  return (
    <div
      className={'text-item' + (selected ? ' selected' : '')}
      style={{ left: x * frame.width, top: y * frame.height, transform: 'translate(-50%, -50%)', textAlign: view.align, touchAction: 'none' }}
      onPointerDown={onPointerDown}
    >
      <span
        style={{
          fontFamily: `"${view.fontFamily}", sans-serif`,
          fontSize: fontPx,
          // 800 matches textRender (export) so bold captions read heavy + identical
          // on phones (where desktop fonts fall back to the system sans) and desktop.
          fontWeight: view.bold ? 800 : 400,
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
