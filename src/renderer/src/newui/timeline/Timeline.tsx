// Timeline root: composes the sticky ruler, sticky track headers, lanes and
// playhead into one scroll surface, and translates pointer gestures into engine
// frames. It renders the drag *preview* while a drag is in flight, so clips move
// live and the drop is a single undoable command. Zero editing logic lives here.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useEngine, useTimeline } from './TimelineContext'
import { dropNeighbour } from './actions'
import { TimelineToolbar } from './TimelineToolbar'
import { ContextMenu, type MenuItem } from './ContextMenu'
import * as C from '@shared/timeline/commands'
import type { Command } from '@shared/timeline/commands'
import type { TimelineDocument } from '@shared/timeline/types'
import { createClip, mainTrackId } from '@shared/timeline/model'
import { uid } from '@shared/timeline/ids'
import { ecPrompt } from '../../ui/ecPrompt'
import { useStore } from '../../store'
import { Ruler } from './Ruler'
import { TrackHeader } from './TrackHeader'
import { TrackLane } from './TrackLane'
import { ClipView } from './ClipView'
import { Playhead } from './Playhead'
import { HEADER_W, RULER_H, MIN_ZOOM, MAX_ZOOM, TRACK_COLOR, frameToPx, pxToFrame, clamp, laneHeight } from './geometry'
import { secondsToFrames, formatTimecode } from '@shared/timeline/time'

/** Clip ids whose [start,end] × lane-Y overlaps the frame×content-Y rectangle. */
function clipsInRect(doc: TimelineDocument, f0: number, f1: number, y0: number, y1: number): string[] {
  const ids: string[] = []
  let y = 0
  for (const t of doc.tracks) {
    const top = y
    const bottom = y + laneHeight(t)
    if (bottom > y0 && top < y1) {
      for (const c of t.clips) if (c.start < f1 && c.end > f0) ids.push(c.id)
    }
    y = bottom
  }
  return ids
}

export default function Timeline({ mobile = false }: { mobile?: boolean }): JSX.Element {
  const engine = useEngine()
  const { doc, session, interaction } = useTimeline()
  const tb = doc.timebase
  const zoom = session.zoom
  // While dragging, render the uncommitted preview so clips move live.
  const activeDoc = interaction.drag ? interaction.drag.preview : doc
  const dragging = interaction.drag !== null

  const scrollRef = useRef<HTMLDivElement>(null)
  const zoomAnchor = useRef<{ frame: number; viewportX: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dropActive, setDropActive] = useState(false)
  /** The clip currently carried by the pointer, in VIEWPORT coords (fixed-positioned
   *  so it can float over any lane, the ruler, or empty space below the tracks). */
  const [float, setFloat] = useState<{ id: string; x: number; y: number; w: number; h: number; grabX: number; grabY: number } | null>(null)
  const [viewW, setViewW] = useState(1400)

  // Measure the scroll viewport so the lanes always fill it — otherwise zooming out
  // shrinks the content narrower than the panel and leaves a blank strip on the right.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    setViewW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const padFrames = secondsToFrames(30, tb)
  const laneWidth = Math.max(frameToPx(activeDoc.duration + padFrames, zoom, tb), viewW - HEADER_W)
  const lanesHeight = activeDoc.tracks.reduce((h, t) => h + laneHeight(t), 0)
  const gridHeight = RULER_H + lanesHeight

  // --- pointer -> frame/track geometry (reads live engine state, no stale closures) ---
  const frameFromClientX = useCallback(
    (clientX: number): number => {
      const el = scrollRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const contentX = el.scrollLeft + (clientX - rect.left) - HEADER_W
      return pxToFrame(contentX, engine.sessionState.zoom, engine.document.timebase)
    },
    [engine]
  )

  const dropTargetFromClientY = useCallback(
    (clientY: number): { trackId?: string; zone?: 'above' | 'below' } => {
      const el = scrollRef.current
      if (!el) return {}
      const rect = el.getBoundingClientRect()
      let y = el.scrollTop + (clientY - rect.top) - RULER_H
      if (y < 0) return { zone: 'above' }
      for (const t of engine.document.tracks) {
        const lh = laneHeight(t)
        if (y >= 0 && y < lh) return { trackId: t.id }
        y -= lh
      }
      return { zone: 'below' }
    },
    [engine]
  )

  // --- cursor-anchored Ctrl+wheel zoom (native, non-passive) ---
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    const el = scrollRef.current
    if (!anchor || !el) return
    el.scrollLeft = HEADER_W + frameToPx(anchor.frame, zoom, tb) - anchor.viewportX
    zoomAnchor.current = null
  }, [zoom, tb])

  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const el = scrollRef.current
      if (!el) return
      const s = engine.sessionState
      const rect = el.getBoundingClientRect()
      const viewportX = e.clientX - rect.left
      const contentX = el.scrollLeft + viewportX - HEADER_W
      const frame = pxToFrame(contentX, s.zoom, engine.document.timebase)
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      zoomAnchor.current = { frame, viewportX }
      engine.setZoom(clamp(s.zoom * factor, MIN_ZOOM, MAX_ZOOM))
    },
    [engine]
  )
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // --- keyboard shortcuts (industry standard; ignored while typing in a field) ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod) {
        if (k === 'z') {
          e.preventDefault()
          if (e.shiftKey) {
            if (engine.canRedo()) engine.redo()
            else useStore.getState().redo()
          } else {
            // A cut apply (silence clean / retake Execute) spans BOTH undo
            // stacks: project.silences + transcript flags live in the STORE,
            // while the routed lane deletion ('Apply cuts') lives in the
            // ENGINE. Undoing only the engine half restores the lane but
            // leaves the cuts applied in the project — the next Apply routes
            // them right back, so settings could never be A/B-tested. When
            // the engine's top entry is that routed cut — or the engine has
            // nothing — undo the PROJECT instead: its snapshot carries the
            // pre-cut timeline document, and TimelinePanel re-hydrates the
            // engine from it, so video, transcript and silences all revert
            // together.
            if (!engine.canUndo() || engine.historyLabels().undo === 'Apply cuts') useStore.getState().undo()
            else engine.undo()
          }
        } else if (k === 'y') {
          e.preventDefault()
          if (engine.canRedo()) engine.redo()
          else useStore.getState().redo()
        } else if (k === 'c') {
          e.preventDefault()
          engine.copySelection()
        } else if (k === 'x') {
          e.preventDefault()
          engine.cutSelection()
        } else if (k === 'v') {
          e.preventDefault()
          engine.pasteAt(engine.sessionState.playhead)
        } else if (k === 'd') {
          e.preventDefault()
          engine.duplicateSelection()
        } else if (k === 'a') {
          e.preventDefault()
          engine.selectAll()
        }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        engine.deleteSelection(!e.shiftKey) // Delete = ripple, Shift+Delete = leave gap
      } else if (k === 'd') {
        // The toolbar prints D on its Delete button; without this it printed a
        // shortcut that did nothing. Ripple, matching what that button does.
        e.preventDefault()
        engine.deleteSelection(true)
      } else if (k === 's') {
        e.preventDefault()
        engine.splitAtPlayhead()
      } else if (k === 'q') {
        e.preventDefault()
        dropNeighbour(engine, -1)
      } else if (k === 'e') {
        e.preventDefault()
        dropNeighbour(engine, 1)
      } else if (k === 'm') {
        // Advertised in the Magnet button's tooltip; same toggle.
        e.preventDefault()
        engine.updateSettings({ magnet: !engine.sessionState.settings.magnet })
      } else if (e.key === 'Escape') {
        engine.clearSelection()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const step = e.shiftKey ? secondsToFrames(1, engine.document.timebase) : 1
        engine.setPlayhead(engine.sessionState.playhead - step)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const step = e.shiftKey ? secondsToFrames(1, engine.document.timebase) : 1
        engine.setPlayhead(engine.sessionState.playhead + step)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine])

  // --- ruler scrub ---
  const onRulerPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.stopPropagation()
      // Scrubbing is an explicit transport takeover. Pause synchronously before
      // the first coalesced seek so playback cannot advance the playhead between
      // pointerdown and the next rAF flush.
      if (useStore.getState().playing) useStore.getState().setPlaying(false)
      // rAF-coalesced, latest-position-wins. pointermove can fire faster than
      // the frame rate, and every event used to become an engine setPlayhead →
      // store write → preview adopt — i.e. the seek flood downstream. One write
      // per frame is plenty; pointerup flushes the exact final position so the
      // release frame is never left one rAF stale.
      let latest = e.clientX
      let raf = 0
      const flush = (): void => {
        raf = 0
        engine.setPlayhead(Math.max(0, frameFromClientX(latest)))
      }
      const seek = (cx: number): void => {
        latest = cx
        if (!raf) raf = requestAnimationFrame(flush)
      }
      seek(e.clientX)
      const move = (ev: PointerEvent): void => seek(ev.clientX)
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        if (raf) cancelAnimationFrame(raf)
        flush() // trailing edge: land exactly where the finger was released
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [engine, frameFromClientX]
  )

  // --- clip move (both axes) ---
  const onClipPointerDown = useCallback(
    (clipId: string, e: ReactPointerEvent) => {
      e.stopPropagation()
      if (e.button !== 0) return
      if (e.altKey) {
        // Alt = slip (shift content in place); Alt+Shift = slide (move, neighbours absorb)
        engine.select([clipId])
        engine.beginDrag(e.shiftKey ? 'slide' : 'slip', clipId, frameFromClientX(e.clientX))
        const move = (ev: PointerEvent): void => engine.updateDrag(frameFromClientX(ev.clientX))
        const up = (): void => {
          engine.endDrag()
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        return
      }
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        engine.toggleSelect(clipId)
        return
      }
      // clicking an unselected clip selects just it; clicking one already in a
      // multi-selection keeps the selection so the whole group drags together.
      if (!engine.isSelected(clipId)) engine.select([clipId])
      engine.beginDrag('move', clipId, frameFromClientX(e.clientX))
      // A held clip LIFTS OUT of its lane and follows the pointer on both axes,
      // free of the row it came from — the lane preview underneath still shows
      // where it will actually land, and the drop is unchanged. Snapping the
      // rendered clip to a lane row mid-drag is what made this feel like the
      // clip was being nudged rather than carried.
      const el = (e.target as HTMLElement).closest('.ec-tl-clip') as HTMLElement | null
      if (el) {
        const r = el.getBoundingClientRect()
        const grabX = e.clientX - r.left
        const grabY = e.clientY - r.top
        setFloat({ id: clipId, x: r.left, y: r.top, w: r.width, h: r.height, grabX, grabY })
      }
      const move = (ev: PointerEvent): void => {
        setFloat((f) => (f ? { ...f, x: ev.clientX - f.grabX, y: ev.clientY - f.grabY } : f))
        engine.updateDrag(frameFromClientX(ev.clientX), dropTargetFromClientY(ev.clientY))
      }
      const up = (): void => {
        setFloat(null)
        engine.endDrag()
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [engine, frameFromClientX, dropTargetFromClientY]
  )

  // --- edge trim ---
  const onHandlePointerDown = useCallback(
    (clipId: string, edge: 'in' | 'out', e: ReactPointerEvent) => {
      if (e.button !== 0) return
      // Alt on an edge = roll the shared cut with the adjacent clip.
      if (e.altKey) {
        let leftId: string | undefined = clipId
        if (edge === 'in') {
          const all = engine.document.tracks.flatMap((t) => t.clips)
          const here = all.find((c) => c.id === clipId)
          const lane = here && engine.document.tracks.find((t) => t.id === here.trackId)
          leftId = lane?.clips.find((c) => c.id !== clipId && c.end === here!.start)?.id
        }
        if (leftId) {
          engine.select([clipId])
          engine.beginDrag('roll', leftId, frameFromClientX(e.clientX))
          const rmove = (ev: PointerEvent): void => engine.updateDrag(frameFromClientX(ev.clientX))
          const rup = (): void => {
            engine.endDrag()
            window.removeEventListener('pointermove', rmove)
            window.removeEventListener('pointerup', rup)
          }
          window.addEventListener('pointermove', rmove)
          window.addEventListener('pointerup', rup)
          return
        }
      }
      engine.select([clipId])
      engine.beginDrag(edge === 'in' ? 'trimIn' : 'trimOut', clipId, frameFromClientX(e.clientX))
      const move = (ev: PointerEvent): void => engine.updateDrag(frameFromClientX(ev.clientX))
      const up = (): void => {
        engine.endDrag()
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [engine, frameFromClientX]
  )

  // Empty timeline body: PLAIN click/drag scrubs the playhead (so the red bar can be
  // grabbed anywhere in the track area, not only in the ruler above). Hold
  // Shift/Ctrl/Cmd to rubber-band (marquee) select clips instead.
  const onEmptyPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      const t = e.target as HTMLElement
      if (t.closest('.ec-tl-header') || t.closest('.ec-tl-rulerRow') || t.closest('.ec-tl-clip')) return
      // Suppress the browser's native text/drag selection on a plain drag —
      // without this it swallows the pointermove stream and the marquee never
      // tracks (a Shift-drag dodged it only because the modifier changes native
      // selection behaviour).
      e.preventDefault()
      const el = scrollRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // Standard-editor gesture: DRAG on the empty lane area = marquee (rubber-band)
      // multi-select across every lane; a plain CLICK (no drag) moves the playhead
      // there. Shift/Ctrl/Cmd adds the marquee's hits to the current selection;
      // otherwise the marquee replaces it. (The ruler still owns scrubbing.)
      const additive = e.shiftKey || e.ctrlKey || e.metaKey
      const startFrame = frameFromClientX(e.clientX)
      const startContentY = el.scrollTop + (e.clientY - rect.top) - RULER_H
      const baseSel = additive ? engine.interactionState.selection.slice() : []
      const startX = e.clientX
      const startY = e.clientY
      let dragging = false
      const move = (ev: PointerEvent): void => {
        if (!dragging) {
          if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return
          dragging = true
          if (!additive) engine.clearSelection()
        }
        const f0 = Math.min(startFrame, frameFromClientX(ev.clientX))
        const f1 = Math.max(startFrame, frameFromClientX(ev.clientX))
        const curY = el.scrollTop + (ev.clientY - rect.top) - RULER_H
        const ids = clipsInRect(engine.document, f0, f1, Math.min(startContentY, curY), Math.max(startContentY, curY))
        engine.select([...baseSel, ...ids])
        setMarquee({ x0: startX, y0: startY, x1: ev.clientX, y1: ev.clientY })
      }
      const up = (): void => {
        if (!dragging && !additive) {
          // plain click on empty space → move the playhead there and deselect
          engine.clearSelection()
          engine.setPlayhead(Math.max(0, startFrame))
        }
        setMarquee(null)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [engine, frameFromClientX]
  )

  // --- right-click context menus ---
  const openClipMenu = useCallback(
    (clipId: string, e: ReactMouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!engine.isSelected(clipId)) engine.select([clipId])
      const items: MenuItem[] = [
        { label: 'Cut', onClick: () => engine.cutSelection() },
        { label: 'Copy', onClick: () => engine.copySelection() },
        { label: 'Duplicate', onClick: () => engine.duplicateSelection() },
        { separator: true },
        { label: 'Split at playhead', onClick: () => engine.splitAtPlayhead() },
        { label: 'Detach audio', onClick: () => engine.dispatch(C.detachAudio(clipId)) },
        { separator: true },
        { label: 'Delete (leave gap)', danger: true, onClick: () => engine.deleteSelection(false) },
        { label: 'Ripple delete', danger: true, onClick: () => engine.deleteSelection(true) }
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [engine]
  )

  const openHeaderMenu = useCallback(
    (trackId: string, e: ReactMouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const track = engine.document.tracks.find((t) => t.id === trackId)
      if (!track) return
      const items: MenuItem[] = [
        {
          label: 'Rename…',
          onClick: () => {
            void ecPrompt('Track name', track.name, 'Rename').then((name) => {
              if (name != null) engine.dispatch(C.renameTrack(trackId, name))
            })
          }
        },
        { label: track.locked ? 'Unlock' : 'Lock', onClick: () => engine.dispatch(C.setTrackFlags(trackId, { locked: !track.locked })) },
        track.kind === 'audio'
          ? { label: track.muted ? 'Unmute' : 'Mute', onClick: () => engine.dispatch(C.setTrackFlags(trackId, { muted: !track.muted })) }
          : { label: track.hidden ? 'Show' : 'Hide', onClick: () => engine.dispatch(C.setTrackFlags(trackId, { hidden: !track.hidden })) },
        { separator: true },
        { label: 'Add video track', onClick: () => engine.dispatch(C.addTrack('video')) },
        { label: 'Delete track', danger: true, disabled: track.isMain, onClick: () => engine.dispatch(C.removeTrack(trackId)) }
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [engine]
  )

  const openEmptyMenu = useCallback(
    (e: ReactMouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('.ec-tl-clip') || t.closest('.ec-tl-header')) return
      e.preventDefault()
      const items: MenuItem[] = [
        { label: 'Paste', disabled: !engine.hasClipboard(), onClick: () => engine.pasteAt(engine.sessionState.playhead) },
        { label: 'Select all', onClick: () => engine.selectAll() },
        { separator: true },
        { label: 'Add video track', onClick: () => engine.dispatch(C.addTrack('video')) },
        { label: 'Add audio track', onClick: () => engine.dispatch(C.addTrack('audio')) },
        { label: 'Add text track', onClick: () => engine.dispatch(C.addTrack('text')) }
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [engine]
  )

  // --- drop media from the library onto a lane (creates a clip) ---
  const onDragOver = useCallback((e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-ec-media')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }, [])

  const onDragLeave = useCallback((e: ReactDragEvent) => {
    if (e.currentTarget === e.target) setDropActive(false)
  }, [])

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      setDropActive(false)
      const id = e.dataTransfer.getData('application/x-ec-media')
      if (!id) return
      e.preventDefault()
      const item = useStore.getState().library.find((it) => it.id === id)
      if (!item) return
      const doc = engine.document
      const tb = doc.timebase
      const isImage = item.kind === 'image'
      const isAudio = item.kind === 'audio'
      const durSec = isImage ? 4 : item.duration || 4
      const kind = isImage ? 'image' : isAudio ? 'audio' : 'video'
      const dropFrame = Math.max(0, frameFromClientX(e.clientX))
      const mainId = mainTrackId(doc)

      // Resolve the target lane: the compatible lane under the cursor, else the
      // main lane for video/image, else a (possibly new) audio lane for audio.
      const under = dropTargetFromClientY(e.clientY).trackId
      const target = under ? doc.tracks.find((t) => t.id === under) : undefined
      const compatible = !!target && ((isAudio && target.kind === 'audio') || (!isAudio && target.kind === 'video'))
      const cmds: Command[] = []
      let trackId: string
      if (compatible) {
        trackId = target!.id
      } else if (isAudio) {
        const a = doc.tracks.find((t) => t.kind === 'audio')
        if (a) trackId = a.id
        else {
          trackId = uid('track')
          cmds.push(C.addTrack('audio', { id: trackId }))
        }
      } else {
        trackId = mainId ?? doc.tracks[0]?.id ?? ''
      }
      if (!trackId) return

      // Dropping straight onto an overlay lane lands full-frame and centred too —
      // without this the renderers' missing-ovScale default (0.45) made every
      // library drop show up as a small off-centre PiP.
      const isOverlayLane = trackId !== mainId && !isAudio
      const clip = createClip({
        kind,
        trackId,
        ...(isOverlayLane ? { metadata: { ovScale: 1, ovX: 0, ovY: 0 } } : {}),
        start: dropFrame,
        duration: secondsToFrames(durSec, tb),
        sourcePath: item.path,
        sourceIn: 0,
        sourceOut: durSec,
        sourceDuration: isImage ? 3600 : item.duration || durSec,
        srcW: item.width,
        srcH: item.height,
        srcFps: item.fps,
        name: item.name,
        hasAudio: item.hasAudio
      })
      // Main lane: insert at the drop point and ripple later clips right; free
      // lanes take the drop point directly.
      cmds.push(trackId === mainId ? C.insertToMain(clip, dropFrame) : C.addClip(clip))
      engine.batch('Add clip', cmds)
      engine.select([clip.id])
    },
    [engine, frameFromClientX, dropTargetFromClientY]
  )

  // The ghost renders the clip as it was PICKED UP (the live doc keeps moving it
  // to the prospective drop slot underneath).
  let floatClip: { clip: (typeof doc.tracks)[number]['clips'][number]; kind: (typeof doc.tracks)[number]['kind'] } | null = null
  if (float) {
    for (const t of doc.tracks) {
      const c = t.clips.find((x) => x.id === float.id)
      if (c) { floatClip = { clip: c, kind: t.kind }; break }
    }
  }
  const noop = (): void => undefined

  const snapLine = interaction.drag?.snapLine ?? null

  return (
    <div className={`ec-tl ${mobile ? 'mobile' : ''} ${dragging ? 'dragging' : ''} ${dropActive ? 'drop-active' : ''}`}>
      {!mobile && <TimelineToolbar />}
      {marquee && (
        <div
          className="ec-tl-marquee"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0)
          }}
        />
      )}
      <div
        className="ec-tl-scroll"
        ref={scrollRef}
        onPointerDown={onEmptyPointerDown}
        onContextMenu={openEmptyMenu}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="ec-tl-grid" style={{ width: HEADER_W + laneWidth, height: gridHeight }}>
          <div className="ec-tl-rulerRow" style={{ height: RULER_H }}>
            <div className="ec-tl-corner" style={{ width: HEADER_W }}>
              <span className="ec-tl-tc">{formatTimecode(session.playhead, tb)}</span>
            </div>
            <div className="ec-tl-rulerHit" style={{ width: laneWidth }} onPointerDown={onRulerPointerDown}>
              <Ruler width={laneWidth} zoom={zoom} />
            </div>
          </div>

          {activeDoc.tracks.map((t) => (
            <div className="ec-tl-row" key={t.id}>
              <TrackHeader track={t} onHeaderContextMenu={openHeaderMenu} />
              <TrackLane
                track={t}
                width={laneWidth}
                zoom={zoom}
                tb={tb}
                selection={interaction.selection}
                waveSize={session.settings.waveformSize}
                onClipPointerDown={onClipPointerDown}
                onHandlePointerDown={onHandlePointerDown}
                onClipContextMenu={openClipMenu}
              />
            </div>
          ))}

          {snapLine !== null && (
            <div
              className="ec-tl-snapline"
              style={{ left: HEADER_W + frameToPx(snapLine, zoom, tb), height: gridHeight }}
            />
          )}
          <Playhead zoom={zoom} tb={tb} height={gridHeight} />
        </div>
      </div>
      {float && floatClip && (
        <div
          className="ec-tl-float"
          style={{ left: float.x, top: float.y, width: float.w, height: float.h }}
        >
          <ClipView
            clip={floatClip.clip}
            zoom={zoom}
            tb={tb}
            color={TRACK_COLOR[floatClip.kind]}
            selected
            waveSize={session.settings.waveformSize}
            onClipPointerDown={noop}
            onHandlePointerDown={noop}
            onClipContextMenu={noop}
          />
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
