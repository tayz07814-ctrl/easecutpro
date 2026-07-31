// EaseCutPro — Stripe Customer Portal session creator.
//
// Returns a URL to Stripe's hosted billing portal for the signed-in user, where
// they can upgrade / downgrade / cancel their subscription, swap payment method,
// and see invoices — all handled by Stripe (proration included). We just map the
// Supabase user to their Stripe customer id (written by the webhook) and mint a
// short-lived portal session. Requires a signed-in user (verify_jwt = true).
//
// Secret (supabase secrets set): STRIPE_SECRET_KEY.
// NOTE: the Customer Portal must be activated once in the Stripe dashboard
// (Settings → Billing → Customer portal) or session creation returns an error.

import { createClient } from 'npm:@supabase/supabase-js@2'

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

function serviceClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

async function requireUser(req: Request): Promise<{ id: string } | null> {
  const auth = req.headers.get('Authorization') ?? ''
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }
  })
  const { data } = await anon.auth.getUser()
  return data.user ? { id: data.user.id } : null
}

function pickOrigin(origin: string | null): string {
  if (origin) {
    try {
      const h = new URL(origin).hostname
      if (/(^|\.)easecutpro\.com$/i.test(h) || /\.vercel\.app$/i.test(h) || h === 'localhost' || h === '127.0.0.1') {
        return origin
      }
    } catch {
      /* malformed Origin — fall through */
    }
  }
  return 'https://easecutpro.com'
}

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    const key = Deno.env.get('STRIPE_SECRET_KEY')
    if (!key) return json({ error: 'Billing is not configured on the server.' }, 500)

    const user = await requireUser(req)
    if (!user) return json({ error: 'Not signed in' }, 401)

    // The Stripe customer id was stamped on the subscription row by the webhook.
    const svc = serviceClient()
    const { data: sub } = await svc
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const customer = sub?.stripe_customer_id as string | undefined
    if (!customer) return json({ error: 'No subscription to manage yet.' }, 400)

    const origin = pickOrigin(req.headers.get('origin'))
    const form = new URLSearchParams()
    form.set('customer', customer)
    form.set('return_url', `${origin}/earlybetatesters`)

    const r = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
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
