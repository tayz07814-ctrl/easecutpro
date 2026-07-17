// Ken Burns (zoom + focal-pan) — one shared, GPU-smooth implementation used by
// EVERY render path (DocPreview base, overlay clips, SequencePreview base) AND
// the exporters, so on-screen motion is identical to the rendered file.
//
// Why the preview is buttery (CapCut-level) with plain CSS, no WebGL:
//
//  • Renders from the ORIGINAL source every frame. A CSS transform re-samples the
//    element's own (untouched) current video/image frame each compositor tick —
//    it never scales an already-scaled frame, so there is zero cumulative drift.
//  • GPU compositing, not CPU repaint. `translateZ(0)` pins the element to its
//    own GPU layer and `scale3d(...)` keeps it on the 3D path, so the browser
//    COMPOSITES the scaled texture on the GPU each vsync instead of rasterizing a
//    new bitmap on the CPU. That is what removes the micro-jitter on subtle
//    zooms. We ALWAYS emit a 3D transform (even at scale 1) so the layer is never
//    promoted/demoted mid-animation — the classic hitch at the start of a
//    100%→130% zoom, where the old code emitted an empty transform until the
//    scale crept past 1.001.
//  • Full float precision. The scale/translate are raw floats — never rounded,
//    floored, or pixel-snapped. The GPU samples at subpixel accuracy (bilinear).
//  • Time-based. Callers pass `progress = elapsedMediaTime / duration` (0..1); we
//    interpolate directly from it and never accumulate per frame, so dropped
//    frames or a variable FPS can never cause a jump or drift.

export type Easing = (t: number) => number

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

// Easing library — each maps 0..1 → 0..1. Ken Burns defaults to easeOutCubic:
// the zoom MOVES from the very first frame (non-zero starting velocity), then
// decelerates to a soft landing. An ease-IN/-in-out curve starts at zero speed,
// so the first ~0.2–0.3s is imperceptible and the zoom reads as a delayed
// animation instead of a camera push — easeOut removes that dead start.
export const Easings = {
  linear: (t: number): number => clamp01(t),
  easeInQuad: (t: number): number => ((t = clamp01(t)), t * t),
  easeOutQuad: (t: number): number => ((t = clamp01(t)), 1 - (1 - t) * (1 - t)),
  easeInOutQuad: (t: number): number => ((t = clamp01(t)), t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeInCubic: (t: number): number => ((t = clamp01(t)), t * t * t),
  easeOutCubic: (t: number): number => ((t = clamp01(t)), 1 - Math.pow(1 - t, 3)),
  easeInOutCubic: (t: number): number => ((t = clamp01(t)), t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeInQuart: (t: number): number => ((t = clamp01(t)), t * t * t * t),
  easeOutQuart: (t: number): number => ((t = clamp01(t)), 1 - Math.pow(1 - t, 4)),
  easeInOutQuart: (t: number): number => ((t = clamp01(t)), t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  easeInQuint: (t: number): number => ((t = clamp01(t)), t * t * t * t * t),
  easeOutQuint: (t: number): number => ((t = clamp01(t)), 1 - Math.pow(1 - t, 5)),
  easeInOutQuint: (t: number): number => ((t = clamp01(t)), t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2)
} as const satisfies Record<string, Easing>

export type EasingName = keyof typeof Easings

/** Default Ken Burns easing. Change here to restyle every zoom, preview + export.
 *  easeOutCubic → the zoom starts moving immediately (no dead ease-in start). */
export const kenBurnsEase: Easing = Easings.easeOutCubic

export interface KenBurnsParams {
  /** base size (1 = fill the frame). */
  size?: number
  /** zoom at progress 0 / 1 (1 = 100%). */
  zoomStart?: number
  zoomEnd?: number
  /** elapsed / duration, 0..1. */
  progress: number
  /** easing (default easeInOutCubic). */
  ease?: Easing
}

/** Interpolated Ken Burns scale at `progress` — a raw float, never rounded. */
export function kenBurnsScale(p: KenBurnsParams): number {
  const ease = p.ease ?? kenBurnsEase
  const zs = p.zoomStart ?? 1
  const ze = p.zoomEnd ?? 1
  return (p.size ?? 1) * (zs + (ze - zs) * ease(clamp01(p.progress)))
}

/**
 * CSS transform for one Ken Burns frame. `translateZ(0)` forces a dedicated GPU
 * compositing layer (composite, not repaint) and `scale3d` keeps it on the 3D
 * path; the scale is a full-precision float so the GPU rasterizes at subpixel
 * accuracy. Always 3D so the layer never flips promotion state mid-zoom.
 */
export function kenBurnsTransform(p: KenBurnsParams): string {
  const s = kenBurnsScale(p)
  return `translateZ(0) scale3d(${s}, ${s}, 1)`
}

/** Focal point (ovX/ovY as fractions of the frame, 0 = centre) → transform-origin.
 *  The zoom pulls toward this point, giving a synchronized zoom + pan. */
export function kenBurnsOrigin(ovX = 0, ovY = 0): string {
  return `${50 + ovX * 100}% ${50 + ovY * 100}%`
}
