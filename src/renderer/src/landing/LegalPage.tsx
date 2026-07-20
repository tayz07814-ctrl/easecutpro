// Legal pages (Terms / Privacy / Refund) — dark shell matching the landing.
// NOTE: the body copy is a pre-launch placeholder; final wording is pending the
// business facts (legal entity, domain, support email, jurisdiction, refund
// window) and that Paddle is the merchant of record. See ROADMAP Phase 2.
import { useEffect } from 'react'

const META: Record<'terms' | 'privacy' | 'refund', { title: string }> = {
  terms: { title: 'Terms of Service' },
  privacy: { title: 'Privacy Policy' },
  refund: { title: 'Refund Policy' }
}

export default function LegalPage({
  kind,
  onNavigate
}: {
  kind: 'terms' | 'privacy' | 'refund'
  onNavigate: (path: string) => void
}): JSX.Element {
  useEffect(() => {
    document.body.classList.add('ec-landing-body')
    window.scrollTo(0, 0)
    return () => document.body.classList.remove('ec-landing-body')
  }, [])

  return (
    <div className="ec-landing" style={{ minHeight: '100vh', background: '#08080A', color: '#F5F5F7' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '120px 32px 90px' }}>
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault()
            onNavigate('/')
          }}
          style={{ color: '#9A9AA6', fontSize: 14.5, cursor: 'pointer' }}
        >
          ← Back to home
        </a>
        <h1
          style={{
            fontFamily: "'Space Grotesk', system-ui, sans-serif",
            fontSize: 'clamp(30px,4vw,44px)',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: '22px 0 0'
          }}
        >
          {META[kind].title}
        </h1>
        <p style={{ marginTop: 18, color: '#9A9AA6', fontSize: 16, lineHeight: 1.7 }}>
          We&rsquo;re finalizing this document ahead of Easecut&rsquo;s public launch. If you have any
          questions in the meantime, please reach out to our support team.
        </p>
      </div>
    </div>
  )
}
