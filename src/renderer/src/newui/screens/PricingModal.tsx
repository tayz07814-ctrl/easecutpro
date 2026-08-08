// Pricing modal — the in-app plan picker. Three cards from PLANS (Pro
// highlighted), CTA per card → Stripe hosted Checkout. On the desktop hybrid
// the checkout opens in the SYSTEM browser (openProCheckout branches on
// IS_DESKTOP_CLOUD); the modal then polls until the Stripe webhook flips the
// subscription on, so the user pays in the browser and comes back to an app
// that already knows it's Pro. On the web build the page navigates to Stripe
// as before, so the waiting state never shows there.
//
// Reachable from anywhere via openPricingModal() (same global-host pattern as
// AccountPanelHost); the topbar ★ Upgrade buttons in Dashboard + Editor use it.

import { useEffect, useRef, useState } from 'react'
import { css } from '../css'
import { useStore } from '../../store'
import { IS_DESKTOP_CLOUD } from '../../platform'
import {
  PLANS,
  openProCheckout,
  openBillingPortal,
  getSubscription,
  isProNow,
  onBillingChange,
  emitBillingChange,
  checkoutConfigured,
  openAccountPanel,
  type PlanId
} from '../../cloud/subscription'

const HAIR = 'rgba(255,255,255,.08)'

// ---- global opener (mirrors registerAccountPanel) ---------------------------
let opener: (() => void) | null = null
export function registerPricingModal(fn: (() => void) | null): void {
  opener = fn
}
/** Open the plan picker from anywhere; falls back to the account panel. */
export function openPricingModal(): void {
  if (opener) opener()
  else openAccountPanel()
}

/** Live Pro flag for topbar buttons: false until known, refreshes on billing
 *  changes. Never fetches when checkout isn't configured (non-cloud builds). */
export function useIsPro(): boolean {
  const user = useStore((s) => s.user)
  const [pro, setPro] = useState(false)
  useEffect(() => {
    if (!checkoutConfigured() || !user) {
      setPro(false)
      return
    }
    let alive = true
    const load = (): void => {
      void getSubscription()
        .then((s) => alive && setPro(isProNow(s)))
        .catch(() => undefined)
    }
    load()
    const un = onBillingChange(load)
    return () => {
      alive = false
      un()
    }
  }, [user])
  return pro
}

/** Longest we ever sit polling for the webhook before giving the sheet back. */
const WAIT_LIMIT_MS = 10 * 60 * 1000

const CARD_PLANS = PLANS.filter((p) => p.id !== 'test')

/** Topbar ★ Upgrade button (Dashboard + Editor). Renders nothing when billing
 *  isn't configured (non-cloud builds) or the user is already Pro. */
export function UpgradeButton(): JSX.Element | null {
  const pro = useIsPro()
  if (!checkoutConfigured() || pro) return null
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        openPricingModal()
      }}
      style={css('flex:none;white-space:nowrap;background:linear-gradient(135deg,#7C6BFF,#9a5cff);border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;padding:8px 14px;border-radius:9px;cursor:pointer;box-shadow:0 4px 14px rgba(124,107,255,.28)')}
    >
      ★ Upgrade
    </button>
  )
}

export default function PricingModalHost(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<PlanId | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')
  const user = useStore((s) => s.user)
  const pro = useIsPro()
  // Set to stop the checkout poll — closing the sheet, or saying "not now".
  const cancelRef = useRef(false)

  useEffect(() => {
    registerPricingModal(() => {
      setErr('')
      setDone(false)
      setOpen(true)
    })
    // Debug hook: lets the plan picker be raised from DevTools even when the
    // Upgrade button is hidden (Pro accounts) — used by the CDP UI checks.
    ;(window as { __openPricing?: () => void }).__openPricing = openPricingModal
    return () => registerPricingModal(null)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        cancelRef.current = true
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const buy = async (plan: PlanId): Promise<void> => {
    if (!user) {
      setErr('Sign in first to upgrade.')
      return
    }
    setErr('')
    setBusy(plan)
    try {
      // Desktop: opens Stripe Checkout in the system browser and RETURNS —
      // then we poll until the webhook writes the subscription. Web: the page
      // navigates away and nothing below runs.
      await openProCheckout(user, plan)
    } catch (e) {
      setBusy(null)
      setErr((e as Error).message || 'Could not start checkout — please try again.')
      return
    }
    // Checkout is OPEN now, so the button stops saying "Opening checkout…" and
    // every plan becomes clickable again — abandoning the browser tab used to
    // leave the whole sheet frozen with no way out but closing it.
    setBusy(null)
    if (!IS_DESKTOP_CLOUD) return // web navigated away; nothing to wait for

    // Poll for the webhook, but CANCELLABLY: someone who closes the browser
    // without paying (or just changes their mind) must be able to stop waiting.
    cancelRef.current = false
    setWaiting(true)
    const deadline = Date.now() + WAIT_LIMIT_MS
    try {
      while (!cancelRef.current && Date.now() < deadline) {
        if (isProNow(await getSubscription())) {
          emitBillingChange()
          setDone(true)
          break
        }
        await new Promise((r) => setTimeout(r, 3000))
      }
    } catch {
      /* a failed poll just means we keep showing the plans */
    } finally {
      setWaiting(false)
    }
  }

  return (
    <div
      onClick={() => {
        cancelRef.current = true // don't keep polling behind a closed sheet
        setOpen(false)
      }}
      style={css('position:fixed;inset:0;z-index:120;background:rgba(6,6,10,.68);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px')}
    >
      <div
        className="ec-newui"
        onClick={(e) => e.stopPropagation()}
        style={css(`width:min(940px,94vw);max-height:92vh;overflow-y:auto;background:#0E0E13;border:1px solid ${HAIR};border-radius:18px;padding:26px 28px 24px;color:#EDEDF2;font-family:inherit`)}
      >
        {/* header */}
        <div style={css('display:flex;align-items:flex-start;gap:12px;margin-bottom:4px')}>
          <div>
            <div style={css('font-size:20px;font-weight:650;letter-spacing:-.02em')}>Upgrade EaseCutPro</div>
            <div style={css('font-size:13px;color:#9A9AAE;margin-top:4px')}>
              AI minutes for retake detection, silence cleaning and transcription — every month.
            </div>
          </div>
          <div style={css('flex:1')} />
          <button
            onClick={() => {
              cancelRef.current = true
              setOpen(false)
            }}
            style={css('background:none;border:none;color:#9A9AAE;font-size:16px;cursor:pointer;padding:4px 8px;font-family:inherit')}
          >
            ✕
          </button>
        </div>

        {/* status banners */}
        {done && (
          <div style={css('margin:12px 0 4px;padding:11px 14px;border-radius:11px;background:rgba(126,217,87,.1);border:1px solid rgba(126,217,87,.3);font-size:13px;color:#B9E8A3')}>
            ★ You’re Pro now — everything is unlocked. Manage your plan anytime in Account settings.
          </div>
        )}
        {waiting && !done && (
          <div style={css('margin:12px 0 4px;padding:11px 14px;border-radius:11px;background:rgba(124,107,255,.09);border:1px solid rgba(124,107,255,.28);font-size:13px;color:#C4BAFF;display:flex;align-items:center;gap:9px')}>
            <span style={css('width:7px;height:7px;border-radius:50%;background:#7C6BFF;animation:ecPulse 1.4s infinite')} />
            <span style={css('flex:1')}>Finish your payment in the browser — this screen updates automatically once it goes through.</span>
            <button
              onClick={() => {
                cancelRef.current = true
              }}
              style={css('flex:none;background:none;border:1px solid rgba(255,255,255,.18);color:#C9C9DA;font-family:inherit;font-size:11.5px;border-radius:7px;padding:5px 10px;cursor:pointer')}
            >
              Not now
            </button>
          </div>
        )}
        {err && (
          <div style={css('margin:12px 0 4px;padding:11px 14px;border-radius:11px;background:rgba(255,91,110,.08);border:1px solid rgba(255,91,110,.3);font-size:13px;color:#FFB3BC')}>
            {err}
          </div>
        )}

        {/* plan cards */}
        <div style={css('display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:18px')}>
          {CARD_PLANS.map((p) => {
            const hot = p.id === 'pro'
            return (
              <div
                key={p.id}
                style={css(
                  `position:relative;display:flex;flex-direction:column;background:#111116;border-radius:14px;padding:20px 18px 18px;border:1px solid ${hot ? 'rgba(124,107,255,.55)' : HAIR}`,
                  hot ? 'box-shadow:0 10px 34px rgba(124,107,255,.16)' : ''
                )}
              >
                {hot && (
                  <div style={css("position:absolute;top:-9px;left:50%;transform:translateX(-50%);background:#7C6BFF;color:#fff;font-family:'Geist Mono',monospace;font-size:9px;letter-spacing:.12em;padding:3px 9px;border-radius:99px")}>
                    MOST POPULAR
                  </div>
                )}
                <div style={css('font-size:14px;font-weight:600')}>{p.name}</div>
                <div style={css('display:flex;align-items:baseline;gap:4px;margin-top:8px')}>
                  <span style={css('font-size:30px;font-weight:650;letter-spacing:-.03em')}>{p.price}</span>
                  <span style={css('font-size:12px;color:#8B8BA0')}>/ month</span>
                </div>
                <div style={css('font-size:11.5px;color:#8B8BA0;margin-top:3px')}>{p.tagline}</div>
                <div style={css(`height:1px;background:${HAIR};margin:14px 0`)} />
                <div style={css('display:flex;flex-direction:column;gap:8px;flex:1')}>
                  {p.features.map((f) => (
                    <div key={f} style={css('display:flex;gap:8px;font-size:12.5px;color:#C9C9DA;line-height:1.45')}>
                      <span style={css(`color:${hot ? '#B7B5F4' : '#7ED957'};flex:none`)}>✓</span>
                      {f}
                    </div>
                  ))}
                </div>
                {pro ? (
                  <button
                    onClick={() => void openBillingPortal().catch((e) => setErr((e as Error).message))}
                    style={css(`margin-top:16px;background:none;border:1px solid ${HAIR};color:#C9C9DA;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:9px 0;cursor:pointer`)}
                  >
                    Switch plan (billing portal)
                  </button>
                ) : (
                  <button
                    disabled={busy !== null}
                    onClick={() => void buy(p.id)}
                    style={css(
                      'margin-top:16px;font-family:inherit;font-size:12.5px;font-weight:600;border-radius:10px;padding:10px 0;cursor:pointer',
                      hot
                        ? 'background:#7C6BFF;border:none;color:#fff;box-shadow:0 4px 16px rgba(124,107,255,.3)'
                        : `background:none;border:1px solid rgba(255,255,255,.14);color:#EDEDF2`,
                      busy !== null ? 'opacity:.55;cursor:default' : ''
                    )}
                  >
                    {busy === p.id ? 'Opening checkout…' : `Get ${p.name}`}
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* footer */}
        <div style={css('display:flex;align-items:center;gap:8px;margin-top:16px;font-size:11.5px;color:#71718A')}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#71718A" strokeWidth="1.5">
            <rect x="3" y="7" width="10" height="7" rx="1.5" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
          </svg>
          Payments are handled securely by Stripe — checkout opens in your browser. Cancel anytime.
          <div style={css('flex:1')} />
          <span onClick={() => { setOpen(false); openAccountPanel() }} style={css('color:#9A9AAE;cursor:pointer;text-decoration:underline')}>
            Account &amp; usage
          </span>
        </div>
      </div>
    </div>
  )
}
