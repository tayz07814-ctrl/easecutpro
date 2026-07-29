// On-device export — overlay & text compositing plan (main-thread side).
//
// The preview composites overlays in the DOM (OverlayLayer: an overflow-hidden
// .ov-box at x*W/y*H sized scale*W with the aspect from the PROBED source,
// the source stretched into an inner rect grown by the crop fractions, Ken
// Burns scaling the inner element about its centre) and the PC export bakes
// text to full-frame PNGs (store.exportVideo → renderTextPng) that ffmpeg
// overlays at 0:0. This module is the canvas twin of both: it turns the
// timeline document into pixel-space draw plans the encoder worker replays per
// frame. Keep the math in lockstep with OverlayLayer.tsx / textRender.ts.

import { framesToSeconds } from '@shared/timeline/time'
import { resolveMedia } from '../media/resolver'
import { drawTextClip } from '../textRender'
import type { TextClip } from '@shared/types'
import type { TimelineDocument } from '@shared/timeline/types'

/** Placement in EXPORT pixels: the clip box (the preview's overflow-hidden
 *  .ov-box, used as a clip rect) and the inner rect the source is stretched
 *  into (the box grown by the crops — cropping slices the edges exactly like
 *  the preview's negative margins). */
export interface OverlayRect {
  bx: number
  by: number
  bw: number
  bh: number
  ix: number
  iy: number
  iw: number
  ih: number
  /** ellipse-masked ("rounded") overlay — clip to the inscribed ellipse, the
   *  canvas twin of the preview's border-radius:50% .ov-clip. */
  round?: boolean
}

/** Eased Ken Burns ramp: zs→ze over the clip's SOURCE window (OverlayBox uses
 *  sourceOut - sourceIn as the ramp length, not the timeline window). */
export interface ZoomRamp {
  zs: number
  ze: number
  start: number
  len: number
}

/** One overlay-lane clip, resolved and in timeline seconds. `z` is the
 *  stacking order — the preview's DOM order (later lanes/clips on top). */
export interface OverlayClipSpec {
  url: string
  src: string
  isImage: boolean
  x: number
  y: number
  scale: number
  crop: { l: number; t: number; r: number; b: number }
  rounded: boolean
  zs: number
  ze: number
  srcW?: number
  srcH?: number
  sourceIn: number
  start: number
  end: number
  /** Ken Burns ramp length = source window (preview twin). */
  rampLen: number
  z: number
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' ? v : d
}

/** Overlay-lane clips (visible video lanes above the main lane) in preview
 *  stacking order. Mirrors OverlayLayer.docOverlays — hidden lanes skipped;
 *  unresolvable sources skipped (whyNotLocal refuses truly-missing ones). */
export function planOverlays(doc: TimelineDocument): OverlayClipSpec[] {
  const tb = doc.timebase
  const out: OverlayClipSpec[] = []
  for (const t of doc.tracks) {
    if (t.kind !== 'video' || t.isMain || t.hidden) continue
    for (const c of t.clips) {
      if (!c.sourcePath) continue
      const r = resolveMedia(c.sourcePath)
      if (!r.url) continue
      const m = c.metadata ?? {}
      out.push({
        url: r.url,
        src: c.sourcePath,
        isImage: c.kind === 'image',
        x: num(m.ovX, 0),
        y: num(m.ovY, 0),
        scale: num(m.ovScale, 0.45),
        crop: { l: c.crop.left, t: c.crop.top, r: c.crop.right, b: c.crop.bottom },
        rounded: m.ovRound === true,
        zs: num(m.ovZoomStart, 1),
        ze: num(m.ovZoomEnd, 1),
        srcW: c.srcW,
        srcH: c.srcH,
        sourceIn: c.sourceIn,
        start: framesToSeconds(c.start, tb),
        end: framesToSeconds(c.end, tb),
        rampLen: Math.max(0.02, c.sourceOut - c.sourceIn),
        z: out.length
      })
    }
  }
  return out
}

/** Text clips → the legacy TextClip shape — the exact mapping the PC export
 *  bakes from (bridge.legacyTextFrom: centre = 0.5 + static transform), with
 *  the PC bake's own too-short/empty filter applied (store.exportVideo). */
export function planTexts(doc: TimelineDocument): TextClip[] {
  const tb = doc.timebase
  const out: TextClip[] = []
  for (const tr of doc.tracks) {
    if (tr.kind !== 'text' || tr.hidden) continue
    for (const c of tr.clips) {
      const t = c.text
      if (!t) continue
      out.push({
        id: c.id,
        text: t.text,
        start: framesToSeconds(c.start, tb),
        end: framesToSeconds(c.end, tb),
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
        bgRadius: t.background.radius,
        bgPadding: t.background.padding,
        bgOpacity: t.background.opacity
      })
    }
  }
  return out.filter((t) => t.end - t.start > 0.05 && t.text.trim())
}

/** OverlayBox's placement math in export pixels. The box aspect comes from the
 *  PROBED source size (16:9 fallback) — even when the decode disagrees, the
 *  preview stretches into this box, so the export stretches identically. */
export function overlayRect(W: number, H: number, o: OverlayClipSpec): OverlayRect {
  const vw = Math.max(0.05, 1 - o.crop.l - o.crop.r)
  const vh = Math.max(0.05, 1 - o.crop.t - o.crop.b)
  const srcAspect = o.srcW && o.srcH ? o.srcW / o.srcH : 16 / 9
  const croppedAspect = srcAspect * (vw / vh)
  const bw = o.scale * W
  const bh = bw / croppedAspect
  const iw = bw / vw
  const ih = bh / vh
  const bx = o.x * W
  const by = o.y * H
  return { bx, by, bw, bh, ix: bx - o.crop.l * iw, iy: by - o.crop.t * ih, iw, ih, round: o.rounded || undefined }
}

/** Full-frame rect for baked text (composited at 0:0 like the ffmpeg overlay). */
export function fullFrameRect(W: number, H: number): OverlayRect {
  return { bx: 0, by: 0, bw: W, bh: H, ix: 0, iy: 0, iw: W, ih: H }
}

/** Bake one text clip at export size. Same drawing code as the PC export's
 *  renderTextPng (fonts, padding, stroke, backgrounds — see textRender.ts),
 *  minus the PNG round-trip; the layout is resolution-relative, so it lands on
 *  the same pixels. */
export function bakeTextBitmap(clip: TextClip, W: number, H: number): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(W))
  canvas.height = Math.max(2, Math.round(H))
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('no 2d canvas'))
  drawTextClip(ctx, clip, canvas.width, canvas.height)
  return createImageBitmap(canvas)
}

/** Decode an image source via <img> — the element the preview uses. fetch() of
 *  blob:/app-protocol media is blocked in some shells; <img> never is, and it
 *  carries the same-origin auth cookies on web. */
export async function loadImageBitmap(url: string): Promise<ImageBitmap> {
  const img = new Image()
  img.src = url
  await img.decode()
  return createImageBitmap(img)
}
