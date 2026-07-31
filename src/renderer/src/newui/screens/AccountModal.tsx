// Account / billing panel — the single place to see your plan, free-trial usage,
// and upgrade. Opened from the dashboard account menu (and auto-opened when the
// free trial runs out). Checkout runs inline; on success it polls the webhook
// and flips to the active plan with a confirmation.
import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import {
  getBilling,
  openProCheckout,
  emitBillingChange,
  stripeTestEnabled,
  PLANS,
  type Billing,
  type PlanId,
  type AccountReason
} from '../../cloud/subscription'

const CARD = '#1E2026'
const HAIR = 'rgba(255,255,255,.09)'

export default function AccountModal({
  open,
  onClose,
  reason
}: {
  open: boolean
  onClose: () => void
  reason?: AccountReason
}): JSX.Element | null {
  const user = useStore((s) => s.user)
  const [billing, setBilling] = useState<Billing | null>(null)
  const [busy, setBusy] = useState<PlanId | null>(null)
  const [upgraded, setUpgraded] = useState(false)

  useEffect(() => {
    if (!open) return
    let active = true
    setUpgraded(false)
    void getBilling().then((b) => {
      if (active) setBilling(b)
    })
    // Just back from a completed Stripe checkout: the webhook writes the sub a
    // beat later — poll until Pro shows, confirm, and let the dashboard refresh.
    if (reason === 'success') {
      setBusy(null)
      void (async () => {
        for (let i = 0; i < 15 && active; i++) {
          const b = await getBilling()
          if (!active) return
          setBilling(b)
          if (b.isPro) {
            setUpgraded(true)
            emitBillingChange()
            return
          }
          await new Promise((r) => setTimeout(r, 2000))
        }
      })()
    }
    return () => {
      active = false
    }
  }, [open, reason])

  if (!open) return null

  async function choose(plan: PlanId): Promise<void> {
    if (!user || busy) return
    setBusy(plan)
    try {
      await openProCheckout({ id: user.id, email: user.email }, plan)
    } catch (e) {
      setBusy(null)
      window.alert(e instanceof Error ? e.message : 'Could not open checkout')
    }
  }

  const isPro = billing?.isPro ?? false
  const trialEnabled = billing?.trialEnabled ?? true
  const used = billing?.runsUsed ?? 0
  const limit = billing?.runsLimit ?? 5
  const left = Math.max(0, limit - used)
  const finalizing = reason === 'success' && !upgraded && !isPro

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,.6)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        overflowY: 'auto',
        padding: '48px 16px',
        fontFamily: "'Hanken Grotesk', system-ui, sans-serif"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '560px',
          background: CARD,
          border: `1px solid ${HAIR}`,
          borderRadius: '16px',
          boxShadow: '0 24px 64px rgba(0,0,0,.55)',
          color: '#EDEDF2'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 22px',
            borderBottom: `1px solid ${HAIR}`
          }}
        >
          <div>
            <div style={{ fontSize: '17px', fontWeight: 600 }}>Account</div>
            <div style={{ fontSize: '13px', color: '#9BA0AC', marginTop: '2px' }}>{user?.email}</div>
          </div>
          <div onClick={onClose} style={{ cursor: 'pointer', color: '#9BA0AC', fontSize: '22px', lineHeight: 1, padding: '4px' }}>
            ×
          </div>
        </div>

        <div style={{ padding: '22px' }}>
          {upgraded && (
            <div
              style={{
                background: 'rgba(52,211,153,.12)',
                border: '1px solid rgba(52,211,153,.4)',
                borderRadius: '12px',
                padding: '14px 16px',
                marginBottom: '18px',
                color: '#7ff0c0',
                fontSize: '14px'
              }}
            >
              🎉 You&rsquo;re on <b>{billing?.planName}</b> — your subscription is active.
            </div>
          )}
          {finalizing && (
            <div
              style={{
                background: 'rgba(52,211,153,.1)',
                border: '1px solid rgba(52,211,153,.35)',
                borderRadius: '12px',
                padding: '14px 16px',
                marginBottom: '18px',
                color: '#7ff0c0',
                fontSize: '14px'
              }}
            >
              ✅ Payment received — activating your subscription… this takes a few seconds.
            </div>
          )}
          {reason === 'trial' && !isPro && !upgraded && trialEnabled && (
            <div
              style={{
                background: 'rgba(245,197,24,.1)',
                border: '1px solid rgba(245,197,24,.35)',
                borderRadius: '12px',
                padding: '14px 16px',
                marginBottom: '18px',
                color: '#F5C518',
                fontSize: '14px'
              }}
            >
              You&rsquo;ve used all {limit} free AI runs. Pick a plan below to keep editing.
            </div>
          )}

          <div style={{ fontSize: '12px', letterSpacing: '.12em', textTransform: 'uppercase', color: '#6E7280', fontWeight: 600 }}>
            Current plan
          </div>
          {billing == null ? (
            <div style={{ color: '#9BA0AC', fontSize: '14px', marginTop: '10px' }}>Loading…</div>
          ) : isPro ? (
            <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '20px', fontWeight: 600 }}>{billing.planName}</span>
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#34D399',
                  border: '1px solid rgba(52,211,153,.4)',
                  borderRadius: '100px',
                  padding: '3px 10px'
                }}
              >
                Active
              </span>
            </div>
          ) : !trialEnabled ? (
            <div style={{ marginTop: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '20px', fontWeight: 600 }}>Free beta</span>
                <span
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#34D399',
                    border: '1px solid rgba(52,211,153,.4)',
                    borderRadius: '100px',
                    padding: '3px 10px'
                  }}
                >
                  Unlimited
                </span>
              </div>
              <div style={{ fontSize: '13px', color: '#9BA0AC', marginTop: '8px' }}>
                Unlimited AI runs while we&rsquo;re in beta — no limits. Enjoy!
              </div>
            </div>
          ) : (
            <div style={{ marginTop: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', marginBottom: '8px' }}>
                <span style={{ fontWeight: 600 }}>Free trial</span>
                <span style={{ color: '#9BA0AC' }}>
                  {used} / {limit} AI runs used
                </span>
              </div>
              <div style={{ height: '8px', borderRadius: '100px', background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(100, (used / limit) * 100)}%`,
                    background: left > 0 ? 'linear-gradient(90deg,#6366F1,#818CF8)' : '#F5C518'
                  }}
                />
              </div>
              <div style={{ fontSize: '13px', color: '#9BA0AC', marginTop: '8px' }}>
                {left > 0 ? `${left} free run${left === 1 ? '' : 's'} left` : 'Trial ended — upgrade to keep editing'}
              </div>
            </div>
          )}

          {!isPro && !finalizing && (
            <>
              <div
                style={{
                  fontSize: '12px',
                  letterSpacing: '.12em',
                  textTransform: 'uppercase',
                  color: '#6E7280',
                  fontWeight: 600,
                  marginTop: '26px',
                  marginBottom: '12px'
                }}
              >
                Choose a plan
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {PLANS.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      border: `1px solid ${p.id === 'pro' ? 'rgba(99,102,241,.5)' : HAIR}`,
                      borderRadius: '12px',
                      padding: '14px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px',
                      background: p.id === 'pro' ? 'rgba(99,102,241,.08)' : 'transparent'
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '15px', fontWeight: 600 }}>
                        {p.name} <span style={{ color: '#9BA0AC', fontWeight: 400 }}>· {p.price}/mo</span>
                      </div>
                      <div style={{ fontSize: '12.5px', color: '#9BA0AC', marginTop: '3px' }}>{p.features.join(' · ')}</div>
                    </div>
                    <button
                      onClick={() => void choose(p.id)}
                      disabled={!!busy}
                      style={{
                        flexShrink: 0,
                        background: p.id === 'pro' ? 'linear-gradient(180deg,#6366F1,#5457E5)' : 'rgba(255,255,255,.06)',
                        border: p.id === 'pro' ? 'none' : `1px solid ${HAIR}`,
                        color: '#fff',
                        fontFamily: 'inherit',
                        fontWeight: 600,
                        fontSize: '13.5px',
                        borderRadius: '10px',
                        padding: '9px 16px',
                        cursor: busy ? 'default' : 'pointer'
                      }}
                    >
                      {busy === p.id ? 'Opening…' : 'Choose'}
                    </button>
                  </div>
                ))}
              </div>
              {stripeTestEnabled() && (
                <button
                  onClick={() => void choose('test')}
                  disabled={!!busy}
                  style={{
                    marginTop: '10px',
                    width: '100%',
                    background: 'transparent',
                    border: `1px dashed ${HAIR}`,
                    color: '#9BA0AC',
                    fontFamily: 'inherit',
                    fontWeight: 600,
                    fontSize: '12.5px',
                    borderRadius: '10px',
                    padding: '9px 16px',
                    cursor: busy ? 'default' : 'pointer'
                  }}
                >
                  {busy === 'test' ? 'Opening…' : 'Run test checkout'}
                </button>
              )}
              <div style={{ fontSize: '12px', color: '#6E7280', marginTop: '12px' }}>
                Secure checkout by Stripe · Cancel anytime · 14-day money-back guarantee
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
