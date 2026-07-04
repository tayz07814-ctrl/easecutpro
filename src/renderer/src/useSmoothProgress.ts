import { useEffect, useRef, useState } from 'react'

/**
 * Continuously-moving progress: eases the DISPLAYED percent toward the job's
 * real percent every frame, and when the job stalls between milestones it keeps
 * creeping slowly toward (but never past) the next one — so the bar always
 * glides instead of stuttering in jumps (0 → 45 → 100).
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
      // a fresh job (target far below shown) restarts the bar
      if (t < s - 25) s = 0
      if (s < t) {
        // ease toward the real value, minimum visible motion 8%/s
        s = Math.min(t, s + Math.max((t - s) * 2.2 * dt, 8 * dt))
      } else if (s < 97) {
        // stalled between milestones: creep gently so the line never freezes
        const ceiling = Math.min(97, t + 12)
        if (s < ceiling) s = Math.min(ceiling, s + 1.5 * dt)
      }
      if (Math.abs(s - shownRef.current) > 0.05) {
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
