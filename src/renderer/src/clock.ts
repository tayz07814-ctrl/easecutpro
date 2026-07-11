// Shared playback clock: the base video's current time, updated each frame by
// VideoPreview's rAF loop. Lets image overlays animate zoom at native fps even
// though <img> has no currentTime.
export const playClock = { t: 0 }

/**
 * Android Chrome blocks HTMLMediaElement.play() unless the call happens INSIDE
 * a user gesture. Our previews START playback from a rAF loop / effect (needed
 * for the element pool + precise cut-skip), which Android rejects with a
 * swallowed NotAllowedError — so the video seeks and shows the current frame
 * but never ADVANCES: frozen playhead, dead transport (iOS/desktop are lenient
 * about deferred play(), which is why it only bites Android). The transport's
 * tap handlers call this SYNCHRONOUSLY so the first play() lands within the
 * gesture; the rAF loop then keeps playback going. Only the visible BASE video
 * (tagged data-ec-base) is touched — overlay videos are left alone.
 */
export function primePlayback(): void {
  try {
    const vids = Array.from(document.querySelectorAll<HTMLVideoElement>('.preview video[data-ec-base]'))
    if (!vids.length) return
    const target = vids.find((v) => v.style.visibility !== 'hidden') ?? vids[0]
    void target.play().catch(() => undefined)
  } catch {
    /* never let the primer throw out of a click handler */
  }
}

/** Smoothstep ease-in-out for zoom/pan ramps — linear motion reads as
 *  mechanical/steppy; this is the preview twin of the export's eased zoompan. */
export function easeInOut(p: number): number {
  const t = Math.min(1, Math.max(0, p))
  return t * t * (3 - 2 * t)
}
