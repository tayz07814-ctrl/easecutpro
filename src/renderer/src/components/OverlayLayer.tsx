import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { playClock } from '../clock'
import { mediaSrc } from '../platform'
import { useSharedEngineSnapshot, getSharedEngine } from '../timelineEngine'
import { framesToSeconds, secondsToFrames } from '@shared/timeline/time'
import { mainTrackId } from '@shared/timeline/model'
import * as C from '@shared/timeline/commands'
import type { Clip } from '@shared/types'
import type { TimelineDocument } from '@shared/timeline/types'

function ecurl(p: string): string {
  return mediaSrc(p)
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** A flat placement descriptor the box renderer consumes — the same shape whether
 *  it came from the legacy project or the timeline document. */
interface OverlayView {
  id: string
  sourcePath: string
  isImage: boolean
  x: number
  y: number
  scale: number
  crop: { l: number; t: number; r: number; b: number }
  zoomStart: number
  zoomEnd: number
  srcW?: number
  srcH?: number
  sourceIn: number
  sourceOut: number
  start: number // seconds on the (edited) timeline
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' ? v : d
}

/** Active overlay clips from the authoritative document, converted to OverlayView. */
function docOverlays(doc: TimelineDocument, playheadSec: number): OverlayView[] {
  const tb = doc.timebase
  const ph = secondsToFrames(playheadSec, tb)
  const mainId = mainTrackId(doc)
  const out: OverlayView[] = []
  for (const t of doc.tracks) {
    if (t.kind !== 'video' || t.isMain || t.id === mainId || t.hidden) continue
    for (const c of t.clips) {
      if (!c.sourcePath) continue
      if (ph < c.start || ph >= c.end) continue
      const m = c.metadata ?? {}
      out.push({
        id: c.id,
        sourcePath: c.sourcePath,
        isImage: c.kind === 'image',
        x: num(m.ovX, 0),
        y: num(m.ovY, 0),
        scale: num(m.ovScale, 0.45),
        crop: { l: c.crop.left, t: c.crop.top, r: c.crop.right, b: c.crop.bottom },
        zoomStart: num(m.ovZoomStart, 1),
        zoomEnd: num(m.ovZoomEnd, 1),
        srcW: c.srcW,
        srcH: c.srcH,
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
        start: framesToSeconds(c.start, tb)
      })
    }
  }
  return out
}

/** Active overlay clips from the legacy project. */
function legacyOverlays(clips: Clip[], playhead: number): OverlayView[] {
  const out: OverlayView[] = []
  for (const c of clips) {
    const len = c.sourceOut - c.sourceIn
    if (playhead < c.start || playhead >= c.start + len) continue
    out.push({
      id: c.id,
      sourcePath: c.sourcePath,
      isImage: !!c.isImage,
      x: c.x,
      y: c.y,
      scale: c.scale,
      crop: c.crop ?? { l: 0, t: 0, r: 0, b: 0 },
      zoomStart: c.zoomStart ?? 1,
      zoomEnd: c.zoomEnd ?? 1,
      srcW: c.srcW,
      srcH: c.srcH,
      sourceIn: c.sourceIn,
      sourceOut: c.sourceOut,
      start: c.start
    })
  }
  return out
}

/** Renders overlay/B-roll clips composited over the base preview frame. Reads from
 *  the timeline document when the project is document-driven, else the legacy tracks. */
export default function OverlayLayer({ frame }: { frame: Rect }): JSX.Element {
  const project = useStore((s) => s.project)
  const playhead = useStore((s) => s.project.playhead)
  const selectedClipId = useStore((s) => s.selectedClipId)
  const selectClip = useStore((s) => s.selectClip)
  const updateClip = useStore((s) => s.updateClip)
  const snap = useSharedEngineSnapshot()
  const docMode = !!project.timeline && !!snap?.doc

  const active: OverlayView[] = docMode
    ? docOverlays(snap!.doc, playhead)
    : legacyOverlays(project.tracks.flatMap((t) => (t.index === 0 ? [] : t.clips)), playhead)

  // Commit a placement change: an undoable engine edit in doc mode, else the store.
  const commit = (id: string, patch: { x?: number; y?: number; scale?: number }): void => {
    if (docMode) {
      const engine = getSharedEngine()
      engine?.dispatch(C.setOverlayPlacement(id, { ovX: patch.x, ovY: patch.y, ovScale: patch.scale }))
    } else {
      updateClip(id, patch)
    }
  }
  const select = (id: string): void => {
    if (docMode) getSharedEngine()?.select([id])
    else selectClip(id)
  }
  const selId = docMode ? snap!.interaction.selection[0] ?? null : selectedClipId

  return (
    <div className="overlay-layer" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}>
      {active.map((c) => (
        <OverlayBox key={c.id} view={c} frame={frame} selected={selId === c.id} onCommit={commit} onSelect={select} />
      ))}
    </div>
  )
}

function OverlayBox({
  view,
  frame,
  selected,
  onCommit,
  onSelect
}: {
  view: OverlayView
  frame: Rect
  selected: boolean
  onCommit: (id: string, patch: { x?: number; y?: number; scale?: number }) => void
  onSelect: (id: string) => void
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const isImage = view.isImage
  const playing = useStore((s) => s.playing)
  const playhead = useStore((s) => s.project.playhead)

  // Live drag/resize is kept in local state so the box follows the pointer without
  // spamming undoable edits; the final value commits once on pointer-up.
  const [live, setLive] = useState<{ x?: number; y?: number; scale?: number } | null>(null)
  const x = live?.x ?? view.x
  const y = live?.y ?? view.y
  const scale = live?.scale ?? view.scale

  const crop = view.crop
  const vw = Math.max(0.05, 1 - crop.l - crop.r)
  const vh = Math.max(0.05, 1 - crop.t - crop.b)
  const srcAspect = view.srcW && view.srcH ? view.srcW / view.srcH : 16 / 9
  const croppedAspect = srcAspect * (vw / vh)

  const boxW = scale * frame.width
  const boxH = boxW / croppedAspect
  const innerW = boxW / vw
  const innerH = boxH / vh

  const len = view.sourceOut - view.sourceIn
  const zs = view.zoomStart ?? 1
  const ze = view.zoomEnd ?? 1

  // Sync overlay video time to the timeline (videos only).
  useEffect(() => {
    const v = ref.current
    if (!v || isImage) return
    const target = view.sourceIn + (playhead - view.start)
    if (playing) {
      if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = target
      v.play().catch(() => undefined)
    } else {
      v.pause()
      if (Math.abs(v.currentTime - target) > 0.05) v.currentTime = target
    }
  }, [playing, playhead, view.sourceIn, view.start, isImage])

  // Smooth Ken Burns zoom across the clip.
  useEffect(() => {
    const el: HTMLElement | null = isImage ? imgRef.current : ref.current
    if (!el) return
    const zoomFromProg = (prog: number): number => zs + (ze - zs) * Math.min(1, Math.max(0, prog))
    const progAt = (): number => {
      if (isImage) return len > 0 ? (playClock.t - view.start) / len : 0
      const v = ref.current
      return v && len > 0 ? (v.currentTime - view.sourceIn) / len : 0
    }
    if (playing) {
      let raf = 0
      const loop = (): void => {
        el.style.transform = `scale(${zoomFromProg(progAt())})`
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    }
    el.style.transform = `scale(${zoomFromProg(len > 0 ? (playhead - view.start) / len : 0)})`
    return undefined
  }, [playing, playhead, view.start, view.sourceIn, len, zs, ze, isImage])

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
      nx = clamp(x0 + (ev.clientX - sx) / frame.width, -0.3, 1)
      ny = clamp(y0 + (ev.clientY - sy) / frame.height, -0.3, 1)
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

  function startResize(e: React.MouseEvent): void {
    e.stopPropagation()
    onSelect(view.id)
    const sx = e.clientX
    const w0 = boxW
    let ns = view.scale
    function onMove(ev: MouseEvent): void {
      ns = clamp((w0 + (ev.clientX - sx)) / frame.width, 0.05, 1.6)
      setLive({ scale: ns })
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setLive(null)
      onCommit(view.id, { scale: ns })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={'ov-box' + (selected ? ' selected' : '')}
      style={{ left: x * frame.width, top: y * frame.height, width: boxW, height: boxH }}
      onPointerDown={startMove}
    >
      {isImage ? (
        <img
          ref={imgRef}
          src={ecurl(view.sourcePath)}
          draggable={false}
          style={{ width: innerW, height: innerH, marginLeft: -crop.l * innerW, marginTop: -crop.t * innerH, transformOrigin: 'center center' }}
        />
      ) : (
        <video
          ref={ref}
          src={ecurl(view.sourcePath)}
          muted
          style={{ width: innerW, height: innerH, marginLeft: -crop.l * innerW, marginTop: -crop.t * innerH, transformOrigin: 'center center' }}
        />
      )}
      {selected && <div className="ov-resize" onPointerDown={startResize} />}
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
