// Public marketing landing page (signed-out cloud visitors). The approved
// design lives verbatim in landing.template.html and is injected here; runtime.ts
// supplies the interactivity and wires CTAs. Kept out of the editor bundle paths
// so it only loads on the marketing routes.
import { useEffect, useRef } from 'react'
import landingHtml from './landing.template.html?raw'
import { initLanding } from './runtime'
import './landing.css'

const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap'

// Load the design's webfonts once (CSP allows fonts.googleapis.com / gstatic —
// see vite.config.cloud.ts). Idempotent across mounts.
function ensureFonts(): void {
  if (document.getElementById('ec-landing-fonts')) return
  const pre1 = document.createElement('link')
  pre1.rel = 'preconnect'
  pre1.href = 'https://fonts.googleapis.com'
  const pre2 = document.createElement('link')
  pre2.rel = 'preconnect'
  pre2.href = 'https://fonts.gstatic.com'
  pre2.crossOrigin = 'anonymous'
  const sheet = document.createElement('link')
  sheet.id = 'ec-landing-fonts'
  sheet.rel = 'stylesheet'
  sheet.href = FONTS_HREF
  document.head.append(pre1, pre2, sheet)
}

export default function LandingScreen({
  onStartFree,
  onNavigate
}: {
  onStartFree: () => void
  onNavigate: (path: string) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ensureFonts()
    document.body.classList.add('ec-landing-body')
    const el = ref.current
    const cleanup = el ? initLanding(el, { onStartFree, onNavigate }) : undefined
    return () => {
      cleanup?.()
      document.body.classList.remove('ec-landing-body')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={ref} className="ec-landing" dangerouslySetInnerHTML={{ __html: landingHtml }} />
}
