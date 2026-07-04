import { useEffect, useState } from 'react'

const MQ = '(max-width: 820px)'

/** True on phone-sized viewports (re-evaluates on resize/rotate). */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MQ).matches
  )
  useEffect(() => {
    const mq = window.matchMedia(MQ)
    const on = (): void => setMobile(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return mobile
}
