import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { playClock } from '../clock'
import { ZoomAnimator } from '../kenBurns'
import { mediaSrc } from '../platform'
import { useSharedEngineSnapshot, getSharedEngine } from '../timelineEngine'
import { framesToSeconds, secondsToFrames } from '@shared/timeline/time'
import { mainTrackId } from '@shared/timeline/model'
import * as C from '@shared/timeline/commands'
import { usePinchDrag } from '../usePinchDrag'
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
  gain: number
  muted: boolean
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
        start: framesToSeconds(c.start, tb),
        // Overlay video clips play their OWN audio (a clip moved off the main lane
        // keeps its sound); detached/muted clips stay silent (audio on their lane).
        gain: num(c.gain, 1),
        muted: c.muted === true || c.audioDetached === true
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
      start: c.start,
      gain: 1,
      muted: true // legacy overlays are silent B-roll (kept as-is)
    })
  }
  return out
}

/** Renders overlay/B-roll clips composited over the base preview frame. Reads from
 *  the timeline document when the project is document-driven, else the legacy tracks. */
export default function OverlayLayer({ frame }: { frame: Rect }): JSX.Element {
  const project = useStore((s) => s.project)
  const storePlayhead = useStore((s) => s.project.playhead)
  const playing = useStore((s) => s.playing)
  const selectedClipId = useStore((s) => s.selectedClipId)
  const selectClip = useStore((s) => s.selectClip)
  const updateClip = useStore((s) => s.updateClip)
  const snap = useSharedEngineSnapshot()
  const docMode = !!project.timeline && !!snap?.doc

  // While playing, follow the base video's 60fps play clock: the store playhead is
  // written only ~8Hz and STALLS over a main-lane gap (e.g. a clip split off to an
  // overlay track with magnet OFF), so overlays gated on it never appear/hide in
  // time. Re-render only when the visible overlay SET changes; each overlay's own
  // A/V + zoom sync reads playClock per frame.
  const legacyClips = docMode ? [] : project.tracks.flatMap((t) => (t.index === 0 ? [] : t.clips))
  const idsAt = (t: number): string =>
    (docMode ? docOverlays(snap!.doc, t) : legacyOverlays(legacyClips, t)).map((o) => o.id).join(',')
  const timeRef = useRef(storePlayhead)
  const [, bump] = useState(0)
  useEffect(() => {
    if (!playing) {
      timeRef.current = storePlayhead
      return undefined
    }
    let raf = 0
    let key = idsAt(playClock.t)
    const tick = (): void => {
      timeRef.current = playClock.t
      const k = idsAt(playClock.t)
      if (k !== key) {
        key = k
        bump((n) => (n + 1) % 1000000)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, storePlayhead, docMode, snap])
  const playhead = playing ? timeRef.current : storePlayhead

  const active: OverlayView[] = docMode
    ? docOverlays(snap!.doc, playhead)
    : legacyOverlays(legacyClips, playhead)

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
  const [guide, setGuide] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })

  return (
    <div className="overlay-layer" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}>
      {active.map((c) => (
        <OverlayBox key={c.id} view={c} frame={frame} selected={selId === c.id} onCommit={commit} onSelect={select} onSnap={setGuide} />
      ))}
      {guide.v && <div className="snap-guide-v" />}
      {guide.h && <div className="snap-guide-h" />}
    </div>
  )
}

function OverlayBox({
  view,
  frame,
  selected,
  onCommit,
  onSelect,
  onSnap
}: {
  view: OverlayView
  frame: Rect
  selected: boolean
  onCommit: (id: string, patch: { x?: number; y?: number; scale?: number }) => void
  onSelect: (id: string) => void
  onSnap: (s: { v: boolean; h: boolean }) => void
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const zoomAnimRef = useRef<ZoomAnimator>()
  if (!zoomAnimRef.current) zoomAnimRef.current = new ZoomAnimator()
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

  // Sync overlay video time to the timeline (videos only) + its own audio. While
  // playing, drive off the 60fps play clock — the store playhead is throttled ~8Hz
  // and stalls over a main-lane gap, which left overlay video frozen + silent.
  useEffect(() => {
    const v = ref.current
    if (!v || isImage) return
    v.muted = view.muted
    v.volume = Math.min(1, Math.max(0, view.gain))
    if (playing) {
      let raf = 0
      const loop = (): void => {
        const target = view.sourceIn + (playClock.t - view.start)
        if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = target
        if (v.paused) v.play().catch(() => undefined)
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    }
    v.pause()
    const target = view.sourceIn + (playhead - view.start)
    if (Math.abs(v.currentTime - target) > 0.05) v.currentTime = target
    return undefined
  }, [playing, playhead, view.sourceIn, view.start, view.muted, view.gain, isImage])

  // Ken Burns zoom across the clip — handed to the compositor (Web Animations
  // API) so it renders at the display refresh rate off its own smooth clock,
  // instead of being re-interpolated on the main thread from the video-derived
  // playClock each frame (which stepped at the video fps and looked choppy on a
  // fast ease-out). Overlays zoom about their centre. Paused → exact frame.
  useEffect(() => {
    const el: HTMLElement | null = isImage ? imgRef.current : ref.current
    const anim = zoomAnimRef.current
    if (!el || !anim) return
    const drive = (isPlaying: boolean, clockSec: number, playheadSec: number): void =>
      anim.drive(el, { origin: 'center center', zoomStart: zs, zoomEnd: ze, startSec: view.start, lenSec: len, playing: isPlaying, clockSec, playheadSec })
    if (playing) {
      let raf = 0
      const loop = (): void => {
        drive(true, playClock.t, playClock.t)
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    }
    drive(false, playhead, playhead)
    return undefined
  }, [playing, playhead, view.start, view.sourceIn, len, zs, ze, isImage])

  // Stop the compositor animation when this overlay unmounts.
  useEffect(() => () => zoomAnimRef.current?.stop(), [])

  // One finger = move (centre snaps to the frame's centre lines); two fingers =
  // pinch-resize. Both commit to the doc, so the export matches what you place.
  const onPointerDown = usePinchDrag({
    frame,
    start: () => ({ x: view.x, y: view.y, scale: view.scale }),
    half: (s) => ({ hw: s / 2, hh: (s * frame.width) / croppedAspect / 2 / frame.height }),
    scaleRange: [0.05, 1.6],
    xRange: [-0.3, 1],
    yRange: [-0.3, 1],
    onSelect: () => onSelect(view.id),
    onLive: (p) => setLive(p),
    onCommit: (p) => {
      setLive(null)
      onCommit(view.id, p)
    },
    onSnap
  })

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
      style={{ left: x * frame.width, top: y * frame.height, width: boxW, height: boxH, touchAction: 'none' }}
      onPointerDown={onPointerDown}
    >
      {isImage ? (
        <img
          ref={imgRef}
          src={ecurl(view.sourcePath)}
          draggable={false}
          style={{ width: innerW, height: innerH, marginLeft: -crop.l * innerW, marginTop: -crop.t * innerH, transformOrigin: 'center center', willChange: 'transform', backfaceVisibility: 'hidden' }}
        />
      ) : (
        <video
          ref={ref}
          playsInline
          src={ecurl(view.sourcePath)}
          style={{ width: innerW, height: innerH, marginLeft: -crop.l * innerW, marginTop: -crop.t * innerH, transformOrigin: 'center center', willChange: 'transform', backfaceVisibility: 'hidden' }}
        />
      )}
      {selected && <div className="ov-resize" onPointerDown={startResize} />}
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
