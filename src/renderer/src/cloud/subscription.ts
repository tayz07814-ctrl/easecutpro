// Cloud build — Pro subscription via Paddle (Merchant of Record).
//
// Paddle.js is loaded from Paddle's CDN on demand (PCI: the card fields are
// served by Paddle, never bundled by us). The checkout passes the Supabase uid
// as custom_data.user_id; the paddle-webhook edge function writes entitlement
// into public.subscriptions, which we read back here to gate Pro. Go-live steps
// (product/price, secrets, webhook destination) live in PAYMENTS.md.
import { getSupabase } from './supabase'

const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js'

type PaddleEnv = 'sandbox' | 'production'

interface PaddleGlobal {
  Environment?: { set(env: PaddleEnv): void }
  Initialize(opts: { token: string; eventCallback?: (e: { name?: string }) => void }): void
  Checkout: {
    open(opts: {
      items: Array<{ priceId: string; quantity?: number }>
      customer?: { email?: string }
      customData?: Record<string, unknown>
      settings?: Record<string, unknown>
    }): void
  }
}
declare global {
  interface Window {
    Paddle?: PaddleGlobal
  }
}

export interface Subscription {
  status: string
  price_id: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean
}

// Live vs sandbox is chosen by HOSTNAME: the production domain uses the live
// Paddle account; every other origin (Vercel previews, localhost) stays on
// sandbox, so a preview build can never take a real card. All values here are
// PUBLIC — the client-side token and price IDs ship in the browser by design —
// so committing them is fine; VITE_PADDLE_* env vars still override either side.
// 'test' is a hidden $1 live price for verifying the real-card loop cheaply —
// never surfaced to normal users (see the ?paddletest gate in the dashboard).
export type PlanId = 'starter' | 'pro' | 'unlimited' | 'test'

const IS_LIVE = typeof window !== 'undefined' && /(^|\.)easecutpro\.com$/i.test(window.location.hostname)

const LIVE = {
  token: 'live_f9ef23fd06dc955c369b83a333c',
  prices: {
    starter: 'pri_01ky0qqtjyn63656vxg90z8szy',
    pro: 'pri_01ky0qrg4c8ggv9978qf8fjxqq',
    unlimited: 'pri_01ky0qss13e7hxbt5ckbkjha2y',
    test: 'pri_01ky0rn6kp0xjtt8rc3nye810d'
  } as Record<PlanId, string>
}
const SANDBOX = {
  token: 'test_2115f33a332b4eaa8bdc588748e',
  prices: {
    starter: 'pri_01kxrsngzrp7x128pz2cjsb7hw',
    pro: 'pri_01ky0mh6qpep3jp2091sp9v1wh',
    unlimited: 'pri_01ky0mn77d161r8vyz15whyp7v',
    test: 'pri_01kxrsngzrp7x128pz2cjsb7hw'
  } as Record<PlanId, string>
}
const DEFAULTS = IS_LIVE ? LIVE : SANDBOX

const clientToken = (import.meta.env.VITE_PADDLE_CLIENT_TOKEN as string | undefined) || DEFAULTS.token
const env: PaddleEnv =
  (import.meta.env.VITE_PADDLE_ENV as PaddleEnv | undefined) || (IS_LIVE ? 'production' : 'sandbox')
const PRICES: Record<PlanId, string | undefined> = {
  starter: (import.meta.env.VITE_PADDLE_PRICE_STARTER as string | undefined) || DEFAULTS.prices.starter,
  pro: (import.meta.env.VITE_PADDLE_PRICE_PRO as string | undefined) || DEFAULTS.prices.pro,
  unlimited: (import.meta.env.VITE_PADDLE_PRICE_UNLIMITED as string | undefined) || DEFAULTS.prices.unlimited,
  test: DEFAULTS.prices.test
}

/** True once a client token and at least one price are configured. The Upgrade
 *  UI stays hidden until then, so a half-configured build never shows a button
 *  that can't open. */
export function paddleConfigured(): boolean {
  return !!(clientToken && (PRICES.starter || PRICES.pro || PRICES.unlimited))
}

// Paddle emits checkout lifecycle events (completed/closed) through the single
// eventCallback set at Initialize; fan them out to whoever's listening.
const eventListeners = new Set<(name: string) => void>()
export function onPaddleEvent(cb: (name: string) => void): () => void {
  eventListeners.add(cb)
  return () => eventListeners.delete(cb)
}

let loading: Promise<PaddleGlobal> | null = null
function loadPaddle(): Promise<PaddleGlobal> {
  if (window.Paddle) return Promise.resolve(window.Paddle)
  if (loading) return loading
  loading = new Promise<PaddleGlobal>((resolve, reject) => {
    if (!clientToken) {
      reject(new Error('Paddle is not configured — set VITE_PADDLE_CLIENT_TOKEN.'))
      return
    }
    const s = document.createElement('script')
    s.src = PADDLE_JS
    s.async = true
    s.onload = () => {
      const P = window.Paddle
      if (!P) {
        reject(new Error('Paddle.js loaded but window.Paddle is missing.'))
        return
      }
      if (env === 'sandbox') P.Environment?.set('sandbox')
      P.Initialize({
        token: clientToken,
        eventCallback: (e) => {
          if (e?.name) for (const cb of eventListeners) cb(e.name)
        }
      })
      resolve(P)
    }
    s.onerror = () => {
      loading = null // let a later click retry
      reject(new Error('Could not load Paddle.js (blocked or offline).'))
    }
    document.head.appendChild(s)
  })
  return loading
}

/** Open the Pro checkout overlay for the signed-in user. `plan` picks the price. */
export async function openProCheckout(
  user: { id: string; email?: string },
  plan: PlanId = 'starter'
): Promise<void> {
  const priceId = PRICES[plan]
  if (!priceId) throw new Error(`No Paddle price configured for the ${plan} plan.`)
  const P = await loadPaddle()
  P.Checkout.open({
    items: [{ priceId, quantity: 1 }],
    customer: user.email ? { email: user.email } : undefined,
    // Echoed back on every subscription webhook — this is how the edge function
    // maps a Paddle subscription to our Supabase user.
    customData: { user_id: user.id },
    settings: { displayMode: 'overlay', theme: 'dark' }
  })
}

/** The signed-in user's subscription row (RLS scopes it to their own), or null. */
export async function getSubscription(): Promise<Subscription | null> {
  const { data, error } = await getSupabase()
    .from('subscriptions')
    .select('status, price_id, current_period_end, cancel_at_period_end')
    .maybeSingle()
  if (error || !data) return null
  return data as Subscription
}

/** Client-side entitlement check, mirroring the public.is_pro() SQL function.
 *  UX only — anything that must be trustworthy is gated server-side by RLS. */
export function isProNow(sub: Subscription | null): boolean {
  if (!sub) return false
  if (sub.status !== 'active' && sub.status !== 'trialing') return false
  if (sub.current_period_end && new Date(sub.current_period_end).getTime() <= Date.now()) return false
  return true
}

/** After checkout completes, the webhook writes the row asynchronously (usually
 *  a second or two). Poll until Pro flips on or we time out. */
export async function waitForPro(timeoutMs = 20000, intervalMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (isProNow(await getSubscription())) return true
    if (Date.now() + intervalMs >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// --- Plans & billing (the account panel + upgrade hub) ---
export interface PlanMeta {
  id: PlanId
  name: string
  price: string
  tagline: string
  features: string[]
}
export const PLANS: PlanMeta[] = [
  {
    id: 'starter',
    name: 'Starter',
    price: '$29',
    tagline: 'For getting started',
    features: ['10 videos per day', 'AI retake detection', 'Smart silence cutter', 'Manual editor', 'Batch processing']
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$49',
    tagline: 'For working creators',
    features: ['20 videos per day', 'Everything in Starter', 'Priority processing']
  },
  {
    id: 'unlimited',
    name: 'Unlimited',
    price: '$79',
    tagline: 'For teams & agencies',
    features: ['Unlimited videos*', 'Everything in Pro', 'Early access features']
  }
]

// Any (live or sandbox) price id → its plan, so we can show the active plan name.
const PRICE_TO_PLAN: Record<string, PlanId> = {}
for (const p of ['starter', 'pro', 'unlimited'] as PlanId[]) {
  PRICE_TO_PLAN[LIVE.prices[p]] = p
  PRICE_TO_PLAN[SANDBOX.prices[p]] = p
}

export interface Billing {
  isPro: boolean
  status: string
  plan: PlanId | null
  planName: string
  runsUsed: number
  runsLimit: number
}

/** Everything the account panel needs — plan + free-trial usage — in one call. */
export async function getBilling(): Promise<Billing> {
  const sb = getSupabase()
  const [subRes, usageRes] = await Promise.all([
    sb.from('subscriptions').select('status, price_id, current_period_end, cancel_at_period_end').maybeSingle(),
    sb.from('usage').select('ai_runs').maybeSingle()
  ])
  const sub = (subRes.data ?? null) as Subscription | null
  const isPro = isProNow(sub)
  const plan = sub?.price_id ? PRICE_TO_PLAN[sub.price_id] ?? null : null
  const planName = plan ? PLANS.find((p) => p.id === plan)?.name ?? 'Pro' : isPro ? 'Pro' : 'Free trial'
  const runsUsed = (usageRes.data?.ai_runs as number | undefined) ?? 0
  return { isPro, status: sub?.status ?? 'none', plan, planName, runsUsed, runsLimit: 5 }
}
