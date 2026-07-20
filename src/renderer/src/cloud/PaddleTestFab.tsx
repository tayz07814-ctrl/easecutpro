// Hidden $1 live-checkout button, for verifying the real-card loop cheaply.
// Renders a fixed floating button ONLY when ?paddletest has been visited
// (persisted to localStorage), on the cloud build, for a signed-in user — so it
// is app-wide (any dashboard) but never shown to normal users. ?paddletest=0
// turns it off. Mounted once in main.tsx alongside <Root/>.
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { IS_CLOUD } from '../platform'
import {
  openProCheckout,
  paddleConfigured,
  onPaddleEvent,
  isProNow,
  getSubscription,
  type Subscription
} from './subscription'

function testEnabled(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('paddletest')
    if (q === '1') {
      localStorage.setItem('ec.paddletest', '1')
      return true
    }
    if (q === '0') {
      localStorage.removeItem('ec.paddletest')
      return false
    }
    return localStorage.getItem('ec.paddletest') === '1'
  } catch {
    return false
  }
}

export default function PaddleTestFab(): JSX.Element | null {
  const user = useStore((s) => s.user)
  const [busy, setBusy] = useState(false)
  const [sub, setSub] = useState<Subscription | null>(null)
  const enabled = IS_CLOUD && paddleConfigured() && testEnabled()

  useEffect(() => {
    if (!enabled || !user) return
    let active = true
    void getSubscription().then((s) => {
      if (active) setSub(s)
    })
    const off = onPaddleEvent(async (name) => {
      if (name === 'checkout.completed' && active) setSub(await getSubscription())
      if ((name === 'checkout.completed' || name === 'checkout.closed') && active) setBusy(false)
    })
    return () => {
      active = false
      off()
    }
  }, [enabled, user?.id])

  if (!enabled || !user) return null
  const uid = user.id
  const email = user.email
  const pro = isProNow(sub)

  async function go(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await openProCheckout({ id: uid, email }, 'test')
    } catch (e) {
      setBusy(false)
      window.alert(e instanceof Error ? e.message : 'Could not open checkout')
    }
  }

  return (
    <button
      onClick={() => void go()}
      disabled={busy}
      style={{
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: 2147483647,
        padding: '12px 18px',
        borderRadius: '12px',
        border: '1px solid rgba(255,255,255,0.15)',
        background: pro ? '#1c7a4a' : 'linear-gradient(180deg,#6366F1,#5457E5)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 600,
        fontSize: '14px',
        cursor: busy ? 'default' : 'pointer',
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)'
      }}
    >
      {pro ? '★ Pro — test active' : busy ? 'Opening…' : '💳 Test checkout ($1)'}
    </button>
  )
}
