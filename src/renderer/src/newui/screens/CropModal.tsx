// Crop & reframe — the redesign's fullscreen crop editor. A draggable/resizable
// box over a 9:16 stage maps to the selected clip's crop (fractions removed from
// each edge) and commits via the SAME undoable engine command the Edit panel's
// crop sliders use (C.setOverlayCrop), so preview + export honour it identically.
//
// The stage is a fixed 9:16 frame (the app's primary vertical format and the
// design's canvas). Crop values are source-relative fractions, so they apply
// correctly regardless; only the aspect-preset box shape assumes a 9:16 source.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { css } from '../css'
import { useStore } from '../../store'
import { useSharedEngineSnapshot, getSharedEngine } from '../../timelineEngine'
import { resolveMedia } from '../../media/resolver'
import { framesToSeconds } from '@shared/timeline/time'
import * as C from '@shared/timeline/commands'
import type { Clip as DocClip } from '@shared/timeline/types'

const STAGE_ASPECT = 9 / 16
const MIN = 0.06 // smallest box edge (fraction)

const ASPECTS: { label: string; ratio: number | null; kind?: 'original' | 'free' }[] = [
  { label: 'Original', ratio: null, kind: 'original' },
  { label: 'Free', ratio: null, kind: 'free' },
  { label: '9:16', ratio: 9 / 16 },
  { label: '1:1', ratio: 1 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '16:9', ratio: 16 / 9 }
]

const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const pct = (v: number): string => `${Math.round(v * 100)}%`

type Corner = 'nw' | 'ne' | 'sw' | 'se'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

export default function CropModal(): JSX.Element | null {
  const setShow = useStore((s) => s.setShowCropModal)
  const snap = useSharedEngineSnapshot()

  // Pin the clip we opened on, so a stray selection change can't swap it mid-edit.
  const pinnedId = useRef<string | null>(snap?.interaction.selection[0] ?? null)
  let clip: DocClip | null = null
  if (pinnedId.current && snap?.doc) {
    for (const tr of snap.doc.tracks) {
      const c = tr.clips.find((cl) => cl.id === pinnedId.current)
      if (c) { clip = c; break }
    }
  }

  const cr = clip?.crop
  const [box, setBox] = useState<Box>(() => ({
    x: cr?.left ?? 0,
    y: cr?.top ?? 0,
    w: Math.max(MIN, 1 - (cr?.left ?? 0) - (cr?.right ?? 0)),
    h: Math.max(MIN, 1 - (cr?.top ?? 0) - (cr?.bottom ?? 0))
  }))
  const cropped = !!cr && (cr.left > 0 || cr.top > 0 || cr.right > 0 || cr.bottom > 0)
  const [aspect, setAspect] = useState(cropped ? 1 : 0) // Free if already cropped, else Original
  const stageRef = useRef<HTMLDivElement>(null)

  // The stage matches the SOURCE frame (fallback 9:16), so the box fractions map
  // 1:1 onto the crop fractions and the still frame underneath is undistorted.
  const stageAspect = clip?.srcW && clip?.srcH ? clip.srcW / clip.srcH : STAGE_ASPECT

  // Still frame to crop against: the clip's frame under the current playhead
  // (clamped into the clip), shown as a paused <video> / <img> filling the stage.
  const playhead = useStore((s) => s.project.playhead)
  const media = clip?.sourcePath ? resolveMedia(clip.sourcePath) : null
  const tb = snap?.doc?.timebase
  let stillT = 0.033
  if (clip && tb && clip.kind !== 'image') {
    const startSec = framesToSeconds(clip.start, tb)
    const endSec = framesToSeconds(clip.end, tb)
    const local = clampN(playhead, startSec, Math.max(startSec, endSec - 0.05)) - startSec
    const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1
    stillT = clampN(clip.sourceIn + local * speed, clip.sourceIn + 0.033, Math.max(clip.sourceIn + 0.033, clip.sourceOut - 0.05))
  }
  const stillRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = stillRef.current
    if (v) v.currentTime = stillT
    // Seek once per open/url — the modal pins its clip, so stillT is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media?.url])

  const close = (): void => setShow(false)

  function rect(): DOMRect | null {
    return stageRef.current?.getBoundingClientRect() ?? null
  }

  // Drag the box body → move (keep size).
  function onMove(e: ReactPointerEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const r = rect()
    if (!r) return
    const sx = e.clientX
    const sy = e.clientY
    const b0 = box
    setAspect((a) => (ASPECTS[a]?.kind === 'original' ? 1 : a))
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - sx) / r.width
      const dy = (ev.clientY - sy) / r.height
      setBox((b) => ({ ...b, x: clampN(b0.x + dx, 0, 1 - b.w), y: clampN(b0.y + dy, 0, 1 - b.h) }))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Drag ANY corner → resize, with the OPPOSITE corner pinned. A ratio preset
  // stays LOCKED to its ratio; Free resizes both axes; Original (a full-frame
  // box) drops to Free.
  function onResize(e: ReactPointerEvent, corner: Corner): void {
    e.preventDefault()
    e.stopPropagation()
    const r = rect()
    if (!r) return
    const sx = e.clientX
    const sy = e.clientY
    const b0 = box
    const a = ASPECTS[aspect]
    // desired box w/h in STAGE-FRACTION space (the stage matches the source frame)
    const locked = a && a.ratio != null ? a.ratio / stageAspect : null
    if (a?.kind === 'original') setAspect(1) // resizing the full frame = free crop

    // Which way this corner grows, and the edge it pivots around. Dragging the
    // left edge leftwards must GROW the box, hence the sign flip; the anchor is
    // whichever edge isn't moving, so the opposite corner stays put.
    const right = corner === 'ne' || corner === 'se'
    const bottom = corner === 'se' || corner === 'sw'
    const signX = right ? 1 : -1
    const signY = bottom ? 1 : -1
    const ax = right ? b0.x : b0.x + b0.w // pinned vertical edge
    const ay = bottom ? b0.y : b0.y + b0.h // pinned horizontal edge
    const maxW = right ? 1 - ax : ax
    const maxH = bottom ? 1 - ay : ay

    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - sx) / r.width
      const dy = (ev.clientY - sy) / r.height
      setBox((b) => {
        let w: number
        let h: number
        if (locked != null) {
          w = clampN(b0.w + signX * dx, MIN, maxW)
          h = w / locked
          if (h > maxH) { h = maxH; w = h * locked }
          if (h < MIN) { h = MIN; w = h * locked }
          if (w > maxW) { w = maxW; h = w / locked }
        } else {
          w = clampN(b0.w + signX * dx, MIN, maxW)
          h = clampN(b0.h + signY * dy, MIN, maxH)
        }
        return { ...b, x: right ? ax : ax - w, y: bottom ? ay : ay - h, w, h }
      })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function pickAspect(i: number): void {
    setAspect(i)
    const a = ASPECTS[i]
    if (a.kind === 'original') { setBox({ x: 0, y: 0, w: 1, h: 1 }); return }
    if (a.kind === 'free' || a.ratio == null) return
    // Largest centred box of the target output ratio within the source stage.
    const rf = a.ratio / stageAspect // desired w/h in stage-fraction space
    let w: number
    let h: number
    if (rf >= 1) { w = 1; h = 1 / rf } else { h = 1; w = rf }
    setBox({ x: (1 - w) / 2, y: (1 - h) / 2, w, h })
  }

  function reset(): void { setBox({ x: 0, y: 0, w: 1, h: 1 }); setAspect(0) }

  function apply(): void {
    if (clip) {
      getSharedEngine()?.dispatch(
        C.setOverlayCrop(clip.id, {
          left: clampN(box.x, 0, 0.94),
          top: clampN(box.y, 0, 0.94),
          right: clampN(1 - box.x - box.w, 0, 0.94),
          bottom: clampN(1 - box.y - box.h, 0, 0.94)
        })
      )
    }
    close()
  }

  const boxStyle = `position:absolute;left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%;box-shadow:0 0 0 9999px rgba(8,8,10,.62);cursor:move`

  return (
    <div style={css('position:fixed;inset:0;background:rgba(4,4,6,.86);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;flex-direction:column;z-index:2200')} className="ec-newui">
      <div style={css('height:56px;flex:none;display:flex;align-items:center;gap:14px;padding:0 22px;border-bottom:1px solid rgba(255,255,255,.07)')}>
        <span style={css('font-size:14px;font-weight:600;letter-spacing:-.01em')}>Crop &amp; reframe</span>
        <span style={css("font-family:'Geist Mono',monospace;font-size:10.5px;color:#7a7a8c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px")}>{clip?.name ?? 'No clip selected'}</span>
        <div style={css('flex:1')} />
        <button onClick={close} style={css('background:transparent;border:none;color:#9a9aae;font-family:inherit;font-size:13px;padding:9px 13px;border-radius:9px;cursor:pointer')}>Cancel</button>
        <button onClick={apply} disabled={!clip} style={css(`background:${clip ? '#7c6bff' : '#191920'};border:none;color:${clip ? '#fff' : '#6e6e85'};font-family:inherit;font-size:13px;font-weight:600;padding:10px 17px;border-radius:9px;cursor:${clip ? 'pointer' : 'not-allowed'}`)}>Apply crop</button>
      </div>

      <div style={css('flex:1;min-height:0;display:flex')}>
        <div style={css('flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:34px')}>
          <div ref={stageRef} style={css(`height:100%;max-width:100%;aspect-ratio:${clip?.srcW && clip?.srcH ? `${clip.srcW}/${clip.srcH}` : '9/16'};position:relative;background-image:repeating-linear-gradient(135deg,#1b1b22 0 8px,#141419 8px 16px);border-radius:6px;overflow:hidden;touch-action:none`)}>
            {/* the actual frame being cropped — the crop box + dim mask sit on top */}
            {media?.url && (clip?.kind === 'image' ? (
              <img src={media.url} alt="" draggable={false} style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none')} />
            ) : (
              <video ref={stillRef} src={media.url} muted playsInline preload="auto" style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none')} />
            ))}
            <div onPointerDown={onMove} style={css(boxStyle)}>
              <div style={css('position:absolute;left:33.3%;top:0;bottom:0;width:1px;background:rgba(255,255,255,.16)')} />
              <div style={css('position:absolute;left:66.6%;top:0;bottom:0;width:1px;background:rgba(255,255,255,.16)')} />
              <div style={css('position:absolute;top:33.3%;left:0;right:0;height:1px;background:rgba(255,255,255,.16)')} />
              <div style={css('position:absolute;top:66.6%;left:0;right:0;height:1px;background:rgba(255,255,255,.16)')} />
              {/* All four corners resize; each draws the two edges it owns so the
                  grab target reads as that corner of the frame. */}
              {(
                [
                  ['nw', 'left:-7px;top:-7px;border-left:2px solid #ededf2;border-top:2px solid #ededf2;cursor:nwse-resize'],
                  ['ne', 'right:-7px;top:-7px;border-right:2px solid #ededf2;border-top:2px solid #ededf2;cursor:nesw-resize'],
                  ['sw', 'left:-7px;bottom:-7px;border-left:2px solid #ededf2;border-bottom:2px solid #ededf2;cursor:nesw-resize'],
                  ['se', 'right:-7px;bottom:-7px;border-right:2px solid #ededf2;border-bottom:2px solid #ededf2;cursor:nwse-resize']
                ] as const
              ).map(([c, pos]) => (
                <div key={c} onPointerDown={(ev) => onResize(ev, c)} style={css(`position:absolute;width:16px;height:16px;${pos}`)} />
              ))}
              <div style={css('position:absolute;left:-1px;top:-1px;width:16px;height:16px;border-left:2px solid #ededf2;border-top:2px solid #ededf2;pointer-events:none')} />
              <div style={css('position:absolute;right:-1px;top:-1px;width:16px;height:16px;border-right:2px solid #ededf2;border-top:2px solid #ededf2;pointer-events:none')} />
              <div style={css('position:absolute;left:-1px;bottom:-1px;width:16px;height:16px;border-left:2px solid #ededf2;border-bottom:2px solid #ededf2;pointer-events:none')} />
            </div>
          </div>
        </div>

        <div style={css('width:300px;flex:none;border-left:1px solid rgba(255,255,255,.07);padding:20px 18px;display:flex;flex-direction:column;gap:18px')}>
          <div>
            <div style={css("font-family:'Geist Mono',monospace;font-size:9.5px;letter-spacing:.1em;color:#5c5c70;margin-bottom:10px")}>ASPECT</div>
            <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:7px')}>
              {ASPECTS.map((a, i) => (
                <div key={a.label} onClick={() => pickAspect(i)} style={css('text-align:center;font-size:12px;padding:9px 0;border-radius:9px;cursor:pointer;border:1px solid', aspect === i ? 'rgba(124,107,255,.5);background:rgba(124,107,255,.14);color:#c4baff;font-weight:600' : 'rgba(255,255,255,.08);color:#9a9aae')}>{a.label}</div>
              ))}
            </div>
          </div>
          <div>
            <div style={css("font-family:'Geist Mono',monospace;font-size:9.5px;letter-spacing:.1em;color:#5c5c70;margin-bottom:10px")}>CROP BOX</div>
            <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:7px')}>
              {([['X', box.x], ['Y', box.y], ['W', box.w], ['H', box.h]] as const).map(([l, v]) => (
                <div key={l} style={css("background:#111117;border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:9px 11px;font-family:'Geist Mono',monospace;font-size:11.5px;color:#c9c9da")}>{l} {pct(v)}</div>
              ))}
            </div>
          </div>
          <div style={css('font-size:12px;color:#7a7a8c;line-height:1.5')}>Drag inside the box to reposition, or pull the bottom-right corner to resize — a ratio preset stays locked while resizing; pick Free for unconstrained. Applies to the selected clip only.</div>
          <div style={css('flex:1')} />
          <span onClick={reset} style={css('text-align:center;font-size:12.5px;color:#d6d6e4;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);padding:10px;border-radius:9px;cursor:pointer')}>Reset to full frame</span>
        </div>
      </div>
    </div>
  )
}
