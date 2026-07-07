// Shared playback clock: the base video's current time, updated each frame by
// VideoPreview's rAF loop. Lets image overlays animate zoom at native fps even
// though <img> has no currentTime.
export const playClock = { t: 0 }

/** Smoothstep ease-in-out for zoom/pan ramps — linear motion reads as
 *  mechanical/steppy; this is the preview twin of the export's eased zoompan. */
export function easeInOut(p: number): number {
  const t = Math.min(1, Math.max(0, p))
  return t * t * (3 - 2 * t)
}
