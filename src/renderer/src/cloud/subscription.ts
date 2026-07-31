// Cloud build — Pro subscription via Stripe (hosted Checkout).
//
// Checkout is a server-created Stripe Checkout Session: the stripe-checkout edge
// function (which holds the secret key) creates the session with the Supabase
// uid in client_reference_id + subscription metadata, and we redirect the
// browser to Stripe's hosted page (PCI: the card fields are Stripe's, never
// ours). Stripe's webhook (stripe-webhook edge fn) writes entitlement into
// public.subscriptions, which we read back here to gate Pro. On return,
// ?checkout=success reopens the account panel and polls until the webhook flips
// Pro on. Go-live steps (prices, secrets, webhook destination) live in PAYMENTS.md.
import { getSupabase, invokeEdge } from './supabase'
import { IS_CLOUD } from '../platform'

export interface Subscription {
  status: string
  price_id: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean
}

// 'test' is a hidden low-cost live price for verifying the real-card loop cheaply
// — never surfaced to normal users (see the ?stripetest gate).
export type PlanId = 'starter' | 'pro' | 'unlimited' | 'test'

// Stripe price ids for the live EaseCut account. NOT secret — they ride in the
// checkout URL; the secret key and the plan→price mapping live in the edge
// function. This map is display-only: it turns a subscription's price_id back
// into a plan name for the account panel.
const PRICE_TO_PLAN: Record<string, PlanId> = {
  price_1Tz4cy2MO59VUOO6Mvc8IYjg: 'starter',
  price_1Tz4cy2MO59VUOO6qw7TnZ7a: 'pro',
  price_1Tz4cz2MO59VUOO6ocs469LB: 'unlimited',
  price_1Tz4oy2MO59VUOO67qsVtvTZ: 'test'
}

/** Checkout is available whenever this is the cloud build — the edge function +
 *  Stripe secret do the work server-side. Gates the upgrade UI. */
export function checkoutConfigured(): boolean {
  return IS_CLOUD
}

// A tiny "billing changed" bus so the dashboard's Pro badge and the account
// panel refresh together once the webhook has written the new subscription.
const listeners = new Set<() => void>()
export function onBillingChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export function emitBillingChange(): void {
  for (const cb of listeners) cb()
}

/** Start Stripe Checkout for the signed-in user and redirect to it. `plan` picks
 *  the price (resolved server-side). The page navigates away to Stripe's hosted
 *  checkout; on completion Stripe returns the buyer to ?checkout=success. */
export async function openProCheckout(
  user: { id: string; email?: string },
  plan: PlanId = 'starter'
): Promise<void> {
  const { url } = await invokeEdge<{ url?: string }>('stripe-checkout', { plan })
  if (!url) throw new Error('Could not start checkout — please try again.')
  window.location.href = url
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
export async function waitForPro(timeoutMs = 30000, intervalMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (isProNow(await getSubscription())) return true
    if (Date.now() + intervalMs >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** Read (and clear) a ?checkout=success|cancel marker Stripe appended on return,
 *  so a refresh doesn't re-trigger it. */
export function consumeCheckoutReturn(): 'success' | 'cancel' | null {
  if (typeof window === 'undefined') return null
  const u = new URL(window.location.href)
  const v = u.searchParams.get('checkout')
  if (v !== 'success' && v !== 'cancel') return null
  u.searchParams.delete('checkout')
  window.history.replaceState({}, '', u.pathname + u.search + u.hash)
  return v
}

/** Hidden test-checkout gate: ?stripetest=1 (persisted to localStorage) lets the
 *  founder run the cheap 'test' price without exposing anything to real users.
 *  ?stripetest=0 turns it off. */
export function stripeTestEnabled(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('stripetest')
    if (q === '1') {
      localStorage.setItem('ec.stripetest', '1')
      return true
    }
    if (q === '0') {
      localStorage.removeItem('ec.stripetest')
      return false
    }
    return localStorage.getItem('ec.stripetest') === '1'
  } catch {
    return false
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
// Minute allowances mirror plan_minute_limit() in the DB — keep the two in sync.
export const PLANS: PlanMeta[] = [
  {
    id: 'starter',
    name: 'Starter',
    price: '$29',
    tagline: 'For getting started',
    features: ['1,200 AI minutes / month', 'AI retake detection', 'Smart silence cutter', 'Manual editor', 'Batch processing']
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$49',
    tagline: 'For working creators',
    features: ['2,500 AI minutes / month', 'Everything in Starter', 'Priority processing']
  },
  {
    id: 'unlimited',
    name: 'Unlimited',
    price: '$79',
    tagline: 'For teams & agencies',
    features: ['Unlimited AI minutes', 'Everything in Pro', 'Early access features']
  },
  // Hidden internal test tier ($1, 100 AI minutes) — never shown in the public
  // plan list (the account panel filters it out); reached only via the
  // ?stripetest checkout. Present here so a test subscription resolves to a name.
  {
    id: 'test',
    name: 'Test',
    price: '$1',
    tagline: 'Internal test tier',
    features: ['100 AI minutes / month']
  }
]

export interface Billing {
  isPro: boolean
  status: string
  plan: PlanId | null
  planName: string
  runsUsed: number
  runsLimit: number
  /** False while the free-trial limit is switched off (private beta = unlimited). */
  trialEnabled: boolean
  /** AI-minute usage for the current billing cycle (subscribers). */
  usedMinutes: number
  /** Plan's AI-minute cap; 0 when uncapped. */
  limitMinutes: number
  minutesUnlimited: boolean
}

/** Everything the account panel needs — plan + free-trial usage — in one call. */
export async function getBilling(): Promise<Billing> {
  const sb = getSupabase()
  const [subRes, usageRes, limitRes, minRes] = await Promise.all([
    sb.from('subscriptions').select('status, price_id, current_period_end, cancel_at_period_end').maybeSingle(),
    sb.from('usage').select('ai_runs').maybeSingle(),
    sb.rpc('ai_run_limit'),
    sb.rpc('ai_usage_status')
  ])
  const sub = (subRes.data ?? null) as Subscription | null
  const isPro = isProNow(sub)
  const plan = sub?.price_id ? PRICE_TO_PLAN[sub.price_id] ?? null : null
  // The server owns the run allowance: <= 0 means the trial is switched off
  // (beta → unlimited). Fall back to a sane default if the read ever fails.
  const runsLimit = typeof limitRes.data === 'number' ? limitRes.data : 5
  const trialEnabled = runsLimit > 0
  const planName = plan
    ? PLANS.find((p) => p.id === plan)?.name ?? 'Pro'
    : isPro
      ? 'Pro'
      : trialEnabled
        ? 'Free trial'
        : 'Free beta'
  const runsUsed = (usageRes.data?.ai_runs as number | undefined) ?? 0
  const min = (minRes.data ?? {}) as { used_minutes?: number; limit_minutes?: number; unlimited?: boolean }
  const limitMinutes = Math.max(0, Math.floor(min.limit_minutes ?? 0))
  const usedMinutes = Math.max(0, Math.floor(min.used_minutes ?? 0))
  const minutesUnlimited = min.unlimited ?? limitMinutes <= 0
  return {
    isPro,
    status: sub?.status ?? 'none',
    plan,
    planName,
    runsUsed,
    runsLimit,
    trialEnabled,
    usedMinutes,
    limitMinutes,
    minutesUnlimited
  }
}

// Lets any code open the account/upgrade panel (e.g. when the free trial runs
// out, or when we return from a completed checkout) without threading UI state
// through the app. The dashboard host registers its opener while mounted.
export type AccountReason = 'trial' | 'success' | null
let accountOpener: ((reason: AccountReason) => void) | null = null
export function registerAccountPanel(fn: ((reason: AccountReason) => void) | null): void {
  accountOpener = fn
}
export function openAccountPanel(reason: AccountReason = null): void {
  accountOpener?.(reason)
}
