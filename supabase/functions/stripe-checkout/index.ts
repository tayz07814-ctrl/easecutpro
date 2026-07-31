// EaseCutPro — Stripe Checkout session creator.
//
// Creates a hosted Stripe Checkout Session for the signed-in user and returns
// its URL; the browser redirects there. The secret key lives ONLY here (Supabase
// secret), never in the frontend — the card fields are served by Stripe. The
// Supabase uid rides on the session as client_reference_id AND on the
// subscription's metadata.user_id, so the stripe-webhook can map the resulting
// subscription back to our user. Requires a signed-in user (verify_jwt = true).
//
// Secret (supabase secrets set): STRIPE_SECRET_KEY (sk_live_…).

import { createClient } from 'npm:@supabase/supabase-js@2'

// Plan → Stripe price id (live EaseCut account). The authority for what a plan
// costs lives here so the client can only ever ask for a known plan by name.
const PRICES: Record<string, string> = {
  starter: 'price_1Tz4cy2MO59VUOO6Mvc8IYjg',
  pro: 'price_1Tz4cy2MO59VUOO6qw7TnZ7a',
  unlimited: 'price_1Tz4cz2MO59VUOO6ocs469LB',
  test: 'price_1Tz4oy2MO59VUOO67qsVtvTZ'
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null
}

async function requireUser(req: Request): Promise<{ id: string; email?: string } | null> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return data.user ? { id: data.user.id, email: data.user.email ?? undefined } : null
}

// Only ever send the buyer back to an origin we recognise; otherwise fall back to
// production so a spoofed Origin header can't redirect the return elsewhere.
function pickOrigin(origin: string | null): string {
  if (origin) {
    try {
      const h = new URL(origin).hostname
      if (/(^|\.)easecutpro\.com$/i.test(h) || /\.vercel\.app$/i.test(h) || h === 'localhost' || h === '127.0.0.1') {
        return origin
      }
    } catch {
      /* malformed Origin — fall through to the default */
    }
  }
  return 'https://easecutpro.com'
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    const key = Deno.env.get('STRIPE_SECRET_KEY')
    if (!key) return json({ error: 'Checkout is not configured on the server.' }, 500)

    const user = await requireUser(req)
    if (!user) return json({ error: 'Not signed in' }, 401)

    const body = await req.json().catch(() => ({}))
    const plan = String(body.plan ?? 'starter')
    const priceId = PRICES[plan]
    if (!priceId) return json({ error: `Unknown plan: ${plan}` }, 400)

    const origin = pickOrigin(req.headers.get('origin'))
    const form = new URLSearchParams()
    form.set('mode', 'subscription')
    form.set('line_items[0][price]', priceId)
    form.set('line_items[0][quantity]', '1')
    form.set('client_reference_id', user.id)
    if (user.email) form.set('customer_email', user.email)
    // Stamp the uid on the subscription itself so EVERY future subscription.*
    // webhook can map back to our user without needing the session.
    form.set('subscription_data[metadata][user_id]', user.id)
    form.set('metadata[user_id]', user.id)
    form.set('allow_promotion_codes', 'true')
    form.set('billing_address_collection', 'auto')
    form.set('success_url', `${origin}/earlybetatesters?checkout=success`)
    form.set('cancel_url', `${origin}/earlybetatesters?checkout=cancel`)

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    })
    const data = await r.json().catch(() => null)
    if (!r.ok) return json({ error: `stripe: ${data?.error?.message ?? `HTTP ${r.status}`}` }, 502)
    return json({ url: data.url })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
