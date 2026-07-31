// EaseCutPro — Stripe webhook (subscription entitlement state).
//
// Stripe calls this server-to-server whenever a subscription is created,
// updated, or canceled (and once when checkout completes). It is the ONLY writer
// of public.subscriptions: the browser reads its own row (RLS) to gate Pro, but
// can never forge entitlement. Authenticated by Stripe's own signature — NOT a
// Supabase JWT — so this function sets `verify_jwt = false` in config.toml.
//
// Secrets (supabase secrets set):
//   STRIPE_SECRET_KEY      — the EaseCut Stripe account's secret key (sk_live_…)
//   STRIPE_WEBHOOK_SECRET  — the endpoint's signing secret (whsec_…)
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
//
// The checkout session stamps the Supabase uid onto the subscription's
// metadata.user_id (and the session's client_reference_id), which Stripe echoes
// back on every subscription event — that's how we map a Stripe subscription to
// our user. Signature verification is hand-rolled with Web Crypto (no SDK) so the
// function is a single self-contained file that runs cleanly on the edge runtime.

import { createClient } from 'npm:@supabase/supabase-js@2'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Replay window — tolerant of network latency + edge cold starts / clock skew.
const MAX_SKEW_SECONDS = 300

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Stripe-Signature: "t=<unix>,v1=<hex>[,v1=<hex>…]". signed payload = `${t}.${raw}`,
// HMAC-SHA256 keyed by the endpoint's signing secret. The body must be the RAW
// bytes — re-serializing (even whitespace) breaks the hash.
async function verifySignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false
  let t = ''
  const v1: string[] = []
  for (const seg of header.split(',')) {
    const i = seg.indexOf('=')
    if (i < 0) continue
    const k = seg.slice(0, i).trim()
    const v = seg.slice(i + 1).trim()
    if (k === 't') t = v
    else if (k === 'v1') v1.push(v)
  }
  if (!t || !v1.length) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > MAX_SKEW_SECONDS) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return v1.some((sig) => timingSafeEqual(hex, sig))
}

interface StripeSubscription {
  id?: string
  customer?: string
  status?: string
  cancel_at_period_end?: boolean
  current_period_end?: number
  items?: { data?: Array<{ current_period_end?: number; price?: { id?: string; product?: string } }> }
  metadata?: { user_id?: string } | null
}

// Map a Stripe subscription onto our entitlement row. current_period_end lives
// on the subscription in older API versions and on the item in newer ones —
// read whichever is present so this survives an account API-version change.
function subToRow(sub: StripeSubscription): Record<string, unknown> {
  const item = sub.items?.data?.[0]
  const price = item?.price
  const periodSecs = sub.current_period_end ?? item?.current_period_end ?? null
  return {
    stripe_subscription_id: sub.id ?? null,
    stripe_customer_id: sub.customer ?? null,
    status: sub.status ?? 'inactive',
    price_id: price?.id ?? null,
    product_id: typeof price?.product === 'string' ? price.product : null,
    current_period_end: periodSecs ? new Date(periodSecs * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString()
  }
}

async function fetchSubscription(id: string, key: string): Promise<StripeSubscription | null> {
  const r = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` }
  })
  if (!r.ok) return null
  return (await r.json()) as StripeSubscription
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const key = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
  if (!key || !secret) return json({ error: 'webhook not configured' }, 500)

  const raw = await req.text() // RAW body — required for the signature; do not parse-then-reserialize
  const sig = req.headers.get('Stripe-Signature')
  if (!(await verifySignature(raw, sig, secret))) return json({ error: 'invalid signature' }, 401)

  let event: { type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(raw)
  } catch {
    return json({ error: 'bad json' }, 400)
  }

  const type = event.type ?? ''
  const obj = event.data?.object ?? {}
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  async function write(sub: StripeSubscription, fallbackUser?: string): Promise<Response> {
    const userId = sub.metadata?.user_id || fallbackUser
    const row = subToRow(sub)
    // user_id (from checkout) is the primary key — upsert on it. If an event ever
    // lacks it, fall back to updating the existing row by subscription id so we
    // don't drop state.
    if (userId) {
      const { error } = await db.from('subscriptions').upsert({ user_id: userId, ...row }, { onConflict: 'user_id' })
      if (error) return json({ error: error.message }, 500)
    } else if (sub.id) {
      const { error } = await db.from('subscriptions').update(row).eq('stripe_subscription_id', sub.id)
      if (error) return json({ error: error.message }, 500)
    } else {
      return json({ ok: true, unmapped: true })
    }
    return json({ ok: true })
  }

  if (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted'
  ) {
    return await write(obj as StripeSubscription)
  }

  // Fast confirm at checkout: fetch the fresh subscription and stamp the user id
  // from the session (belt-and-suspenders for the subscription.* events).
  if (type === 'checkout.session.completed') {
    const session = obj as { subscription?: string; client_reference_id?: string; metadata?: { user_id?: string } }
    const subId = session.subscription
    const userId = session.client_reference_id || session.metadata?.user_id
    if (!subId) return json({ ok: true, ignored: 'no subscription' })
    const sub = await fetchSubscription(subId, key)
    if (!sub) return json({ ok: true, ignored: 'sub fetch failed' })
    return await write(sub, userId)
  }

  // Ack everything else so Stripe stops retrying it.
  return json({ ok: true, ignored: type })
})
