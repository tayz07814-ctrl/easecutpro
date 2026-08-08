import { useEffect, useRef, useState } from 'react'

/**
 * Continuously-moving progress. The bar advances while the job is active so it
 * never looks frozen during a long opaque await, but it can NEVER run away from
 * the real percentage.
 *
 * THE BUG THIS FIXES — "the bar climbs to 30-70% then starts from the
 * beginning, over and over". The old version advanced at a floor of 1.5 %/s
 * regardless of the real value, and reset to 0 whenever the target sat 25
 * points behind. A long render moves far slower than that floor (a 10-minute
 * export is ~0.17 %/s), so the synthetic creep outran the truth, tripped its
 * own reset, and looped — forever, and worse the slower the machine. The
 * underlying job percentage was correct the whole time; only the bar lied.
 *
 * So the creep is now CAPPED just above the real value: it still drifts while
 * nothing is reported, but it cannot overtake the job, which makes the runaway
 * (and the reset that followed it) impossible. A new job is signalled by
 * `resetKey` changing — never inferred from the number going down.
 */

/** Idle drift ceiling: how far past the last real percentage the bar may creep
 *  while waiting for news. Enough to read as alive, too small to run away. */
const IDLE_LEAD = 6

/** One animation step. Pure, so the loop behaviour is testable without React
 *  (see scripts/verify-progress-smoothing.ts). */
export function stepProgress(shown: number, target: number, dt: number): number {
  const t = Math.max(0, Math.min(100, target))
  if (t >= 99.5) {
    // Backend finished → glide the last stretch smoothly up to 100.
    return Math.min(100, shown + Math.max((100 - shown) * 5 * dt, 30 * dt))
  }
  // Ease toward the real value, and keep drifting when it stalls — but never
  // past t + IDLE_LEAD, and never backwards (a bar that retreats reads as a
  // restart). Hard cap at 98 until completion is signalled.
  const ceiling = Math.min(98, t + IDLE_LEAD)
  const eased = shown + Math.max((t - shown) * 2.2 * dt, 1.5 * dt)
  return Math.max(shown, Math.min(ceiling, eased))
}

/**
 * @param active   whether the job is running (false resets the bar)
 * @param target   the real percentage, 0-100
 * @param resetKey change this to start the bar over for a genuinely NEW job
 */
export function useSmoothProgress(active: boolean, target: number, resetKey?: string | number): number {
  const [shown, setShown] = useState(0)
  const shownRef = useRef(0)
  const targetRef = useRef(target)
  targetRef.current = target

  useEffect(() => {
    if (!active) {
      shownRef.current = 0
      setShown(0)
      return
    }
    // A new job while the bar is still up (no inactive gap) starts from 0.
    shownRef.current = 0
    setShown(0)
    let raf = 0
    let last = performance.now()
    const loop = (): void => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const s = stepProgress(shownRef.current, targetRef.current, dt)
      if (Math.abs(s - shownRef.current) > 0.02) {
        shownRef.current = s
        setShown(s)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active, resetKey])

  return active ? shown : 0
}
