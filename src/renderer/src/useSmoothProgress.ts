import { useEffect, useRef, useState } from 'react'

/**
 * Continuously-moving progress. The bar ALWAYS advances while the job is active
 * (≥1.5 %/s), so it can never look frozen even when the backend reports nothing
 * for a long opaque await. The real percent only makes it move FASTER when it's
 * ahead — it never causes a stall. The bar is hard-capped at 98 % until the job
 * signals completion (target ≥ ~100), then it glides smoothly to 100.
 *
 * Shared by the Retake analyze bar, the import wizard, and the legacy global
 * bar; every consumer only renders it while its job is active, so returning 0
 * when inactive keeps their idle state unchanged.
 */
export function useSmoothProgress(active: boolean, target: number): number {
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
    let raf = 0
    let last = performance.now()
    const loop = (): void => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const t = Math.max(0, Math.min(100, targetRef.current))
      let s = shownRef.current
      // a fresh job (target dropped far below shown) restarts the bar
      if (t < s - 25) s = 0
      if (t >= 99.5) {
        // backend finished → glide the last stretch smoothly up to 100
        s = Math.min(100, s + Math.max((100 - s) * 5 * dt, 30 * dt))
      } else {
        // running: NEVER freeze. Advance at least ~1.5 %/s; go faster when the
        // real percent is ahead. Hard cap at 98 until completion is signalled.
        s = Math.min(98, s + Math.max((t - s) * 2.2 * dt, 1.5 * dt))
      }
      if (Math.abs(s - shownRef.current) > 0.02) {
        shownRef.current = s
        setShown(s)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active])

  return active ? shown : 0
}
