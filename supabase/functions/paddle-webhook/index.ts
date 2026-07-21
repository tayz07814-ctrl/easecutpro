// EaseCutPro — Paddle webhook (Merchant-of-Record subscription state).
//
// Paddle calls this server-to-server whenever a subscription is created,
// activated, updated, paused, resumed, or canceled. It is the ONLY writer of
// public.subscriptions: the browser reads its own row (RLS) to gate Pro, but can
// never forge entitlement. Authenticated by Paddle's HMAC signature — NOT a
// Supabase JWT — so this function sets `verify_jwt = false` in config.toml.
//
// Secret (supabase secrets set): PADDLE_WEBHOOK_SECRET — the signing secret of
// the notification destination (Paddle → Developer Tools → Notifications).
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
//
// The checkout passes custom_data.user_id (the Supabase uid), which Paddle
// echoes back on every subscription event — that's how we map a Paddle
// subscription to our user.

import { createClient } from 'npm:@supabase/supabase-js@2'

// Self-contained JSON responder. A server-to-server webhook needs no CORS, so we
// don't pull in _shared/http.ts — this keeps the function a single file.
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Replay window. Paddle's docs suggest 5s, but that's brittle across network
// latency + edge cold starts; 5 min keeps replay protection while tolerating
// real-world delay/clock skew.
const MAX_SKEW_SECONDS = 300

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Paddle-Signature: "ts=<unix>;h1=<hex>". signed payload = `${ts}:${rawBody}`,
// HMAC-SHA256 keyed by the destination secret. The body must be the RAW bytes —
// re-serializing (even whitespace) breaks the hash.
async function verifySignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false
  const parts: Record<string, string> = {}
  for (const seg of header.split(';')) {
    const i = seg.indexOf('=')
    if (i > 0) parts[seg.slice(0, i).trim()] = seg.slice(i + 1).trim()
  }
  const ts = parts.ts
  const h1 = parts.h1
  if (!ts || !h1) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > MAX_SKEW_SECONDS) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${raw}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return timingSafeEqual(hex, h1)
}

interface PaddlePrice {
  id?: string
  product_id?: string
}
interface PaddleSubscription {
  id?: string
  customer_id?: string
  status?: string
  items?: Array<{ price?: PaddlePrice }>
  current_billing_period?: { ends_at?: string | null } | null
  scheduled_change?: { action?: string } | null
  custom_data?: { user_id?: string } | null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // Accept one or more comma-separated signing secrets, so the live and sandbox
  // notification destinations (which share this URL) can both be verified.
  const secrets = (Deno.env.get('PADDLE_WEBHOOK_SECRET') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!secrets.length) return json({ error: 'webhook not configured' }, 500)

  const raw = await req.text() // RAW body — required for the signature; do not parse-then-reserialize
  const sig = req.headers.get('Paddle-Signature')
  let verified = false
  for (const secret of secrets) {
    if (await verifySignature(raw, sig, secret)) {
      verified = true
      break
    }
  }
  if (!verified) return json({ error: 'invalid signature' }, 401)

  let event: { event_type?: string; data?: PaddleSubscription }
  try {
    event = JSON.parse(raw)
  } catch {
    return json({ error: 'bad json' }, 400)
  }

  const type = event.event_type ?? ''
  // Only subscription.* events carry entitlement state; ack + ignore the rest
  // (transactions, adjustments, …) so Paddle stops retrying them.
  if (!type.startsWith('subscription.')) return json({ ok: true, ignored: type })

  const d = event.data ?? {}
  const userId = d.custom_data?.user_id
  const subId = d.id
  const price = d.items?.[0]?.price
  const row = {
    paddle_subscription_id: subId ?? null,
    paddle_customer_id: d.customer_id ?? null,
    status: d.status ?? 'inactive',
    price_id: price?.id ?? null,
    product_id: price?.product_id ?? null,
    current_period_end: d.current_billing_period?.ends_at ?? null,
    cancel_at_period_end: d.scheduled_change?.action === 'cancel',
    updated_at: new Date().toISOString()
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // user_id (from checkout custom_data) is the primary key — upsert on it. If an
  // event ever lacks it (e.g. a subscription created straight from the Paddle
  // dashboard), fall back to updating the existing row by subscription id so we
  // don't drop state.
  if (userId) {
    const { error } = await db.from('subscriptions').upsert({ user_id: userId, ...row }, { onConflict: 'user_id' })
    if (error) return json({ error: error.message }, 500)
  } else if (subId) {
    const { error } = await db.from('subscriptions').update(row).eq('paddle_subscription_id', subId)
    if (error) return json({ error: error.message }, 500)
  } else {
    return json({ ok: true, unmapped: true }) // nothing to key on — ack to stop retries
  }

  return json({ ok: true })
})
