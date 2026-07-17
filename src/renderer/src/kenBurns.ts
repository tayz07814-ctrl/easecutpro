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

// Easing library — each maps 0..1 → 0..1. Ken Burns defaults to `linear`:
// CONSTANT velocity, no acceleration — the zoom glides at a uniform speed from
// the first frame to the last, like a motorized camera slider. (The other
// curves stay available for callers that pass an explicit `ease`.)
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
 *  `linear` → constant velocity, zero acceleration: a perfectly uniform glide. */
export const kenBurnsEase: Easing = Easings.linear

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

// ---------------------------------------------------------------------------
// Compositor-driven playback (Web Animations API)
// ---------------------------------------------------------------------------
//
// Writing `el.style.transform` every rAF frame interpolates the zoom on the
// MAIN thread from `playClock.t` — which is the base video's currentTime, so it
// advances at the video's frame cadence, not the display's refresh rate.
// Resampling that steppy clock each frame (on a thread the editor keeps busy)
// is what makes a FAST ease-out zoom look choppy; the old ease-in's near-frozen
// start simply hid it.
//
// Instead we hand the whole ramp to the browser as a Web Animation: it runs on
// the COMPOSITOR at the display refresh rate off its own smooth clock, immune
// to video-frame stepping and main-thread jank. We only nudge it back into sync
// on a real discontinuity (play start, loop, seek). Paused/scrubbing still
// writes the exact static frame, so a dragged playhead lands precisely.

/** Only correct on a genuine discontinuity — play-start, loop, or seek, which
 *  jump the clock by hundreds of ms to seconds. Normal per-frame advance is
 *  ≤~33ms and gradual video/wall-clock drift stays well under this, so the
 *  compositor free-runs at constant velocity and NEVER snaps mid-glide (a snap
 *  would read as a periodic hitch — the opposite of what we want). */
const DRIFT_RESYNC_MS = 250

export interface ZoomDrive {
  /** transform-origin (focal point) — see kenBurnsOrigin. */
  origin: string
  size?: number
  zoomStart?: number
  zoomEnd?: number
  /** clip start + length in seconds (same time-base as clockSec/playheadSec). */
  startSec: number
  lenSec: number
  playing: boolean
  /** edited time while playing (playClock.t) — used only to detect drift. */
  clockSec: number
  /** exact edited time for a paused / scrubbed frame. */
  playheadSec: number
  ease?: Easing
}

/** Fine-grained keyframes tracing the EXACT Ken Burns scale curve (any easing),
 *  linearly interpolated by the compositor between samples — so the on-screen
 *  motion matches the exporters' polynomial to sub-pixel accuracy while still
 *  rendering at the display refresh rate. */
function zoomKeyframes(p: ZoomDrive, steps = 60): Keyframe[] {
  const out: Keyframe[] = []
  for (let i = 0; i <= steps; i++) {
    const progress = i / steps
    out.push({
      transform: kenBurnsTransform({ size: p.size, zoomStart: p.zoomStart, zoomEnd: p.zoomEnd, progress, ease: p.ease }),
      offset: progress
    })
  }
  return out
}

/**
 * Drives one element's Ken Burns zoom on the compositor. Keep ONE per element
 * (in a ref) and call `drive` every rAF frame while playing and once per paused
 * frame. It rebuilds the underlying Web Animation only when the zoom params or
 * the target element change; ordinary frames just let the compositor run and,
 * at most, correct a large drift. Falls back to a per-frame static write where
 * the Web Animations API is unavailable.
 */
export class ZoomAnimator {
  private anim: Animation | null = null
  private el: HTMLElement | null = null
  private key = ''

  drive(el: HTMLElement, p: ZoomDrive): void {
    if (el !== this.el) {
      this.stop()
      this.el = el
    }
    el.style.transformOrigin = p.origin

    const writeStatic = (): void => {
      const progress = p.lenSec > 0 ? clamp01((p.playheadSec - p.startSec) / p.lenSec) : 0
      el.style.transform = kenBurnsTransform({ size: p.size, zoomStart: p.zoomStart, zoomEnd: p.zoomEnd, progress, ease: p.ease })
    }

    // Paused/scrub, or no WAA support → exact static frame, no animation.
    if (!p.playing || typeof el.animate !== 'function') {
      if (this.anim) { this.anim.cancel(); this.anim = null; this.key = '' }
      writeStatic()
      return
    }

    const lenMs = Math.max(1, p.lenSec * 1000)
    const key = `${p.size ?? 1}|${p.zoomStart ?? 1}|${p.zoomEnd ?? 1}|${lenMs}`
    if (!this.anim || this.key !== key) {
      this.anim?.cancel()
      this.anim = el.animate(zoomKeyframes(p), { duration: lenMs, easing: 'linear', fill: 'both' })
      this.key = key
    }
    const a = this.anim
    const want = p.lenSec > 0 ? clamp01((p.clockSec - p.startSec) / p.lenSec) * lenMs : 0
    const cur = typeof a.currentTime === 'number' ? a.currentTime : Number(a.currentTime ?? 0)
    if (Math.abs(cur - want) > DRIFT_RESYNC_MS) a.currentTime = want
    if (a.playState !== 'running') a.play()
  }

  /** Cancel the animation and clear the inline transform on the current element. */
  stop(): void {
    if (this.anim) { this.anim.cancel(); this.anim = null }
    if (this.el) this.el.style.transform = ''
    this.key = ''
  }
}
