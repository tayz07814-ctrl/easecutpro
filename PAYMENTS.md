# Payments — Pro subscriptions via Paddle

EaseCutPro Pro is billed through **Paddle**, a *Merchant of Record*. Paddle is
the legal seller: it captures cards worldwide, handles global sales tax/VAT, and
pays us out (Payoneer → Pakistani bank). We never touch card data and never need
a Stripe/PayPal merchant account — which is why this works from Pakistan.

## How it fits together

```
Browser (cloud build)                Supabase                        Paddle
─────────────────────                ────────                        ──────
[★ Upgrade to Pro] ── Paddle.js ───────────────────────────────▶ hosted checkout
   customData.user_id = <uid>                                          │ pays
                                                                        │
   subscriptions row ◀── paddle-webhook ◀──── subscription.* event ────┘
   (RLS: read own)       (verify HMAC, service-role write)
[★ Pro] badge      ◀── getSubscription() / public.is_pro()
```

Pieces added:

- **`supabase/migrations/20260717000000_subscriptions.sql`** — `public.subscriptions`
  (one row per user, RLS read-own, **no** client write policy so entitlement
  can't be forged) plus `public.is_pro()`.
- **`supabase/functions/paddle-webhook/index.ts`** — verifies Paddle's HMAC
  signature, then writes entitlement with the service role. `verify_jwt = false`
  (see `supabase/config.toml`).
- **`src/renderer/src/cloud/subscription.ts`** — loads Paddle.js on demand, opens
  the checkout (passing `custom_data.user_id`), reads status back.
- **`HomeScreen`** — shows `★ Upgrade to Pro` / `★ Pro` in the account header.

## One-time setup (do it in **sandbox** first)

1. **Product + price** — Paddle → Catalog → Products → add *EaseCutPro Pro* with a
   recurring price (e.g. $12/mo). Copy the price ID (`pri_…`). Add an annual price
   too if you want one.
2. **Frontend keys** (public) — Paddle → Developer Tools → Authentication → copy
   the **client-side token** (`test_…`). Set these in `.env` (local) and in the
   Vercel project settings (deploys):
   ```
   VITE_PADDLE_CLIENT_TOKEN=test_…
   VITE_PADDLE_ENV=sandbox
   VITE_PADDLE_PRICE_MONTHLY=pri_…
   VITE_PADDLE_PRICE_ANNUAL=pri_…      # optional
   ```
3. **Deploy the backend**:
   ```
   supabase db push                          # creates the subscriptions table
   supabase functions deploy paddle-webhook  # verify_jwt=false comes from config.toml
   ```
4. **Webhook destination** — Paddle → Developer Tools → Notifications → new
   destination:
   - URL: `https://zlqxrdlognjvwqpmnfjq.supabase.co/functions/v1/paddle-webhook`
   - Events: everything under **`subscription.*`** (created, activated, updated,
     canceled, past_due, paused, resumed).
   - Copy the **signing secret** (`ntfset_…`) and store it as a Supabase secret —
     never in the repo:
     ```
     supabase secrets set PADDLE_WEBHOOK_SECRET=ntfset_…
     ```
5. **Test the loop** — run the cloud build, sign in, click **★ Upgrade to Pro**,
   pay with Paddle's sandbox test card (`4242 4242 4242 4242`, any future expiry,
   any CVC). Within a second or two the header should flip to **★ Pro**, and a row
   should appear in `public.subscriptions`.

## Going live

Once the sandbox loop works end-to-end:

- Set `VITE_PADDLE_ENV=production`, and swap in the **live** client-side token and
  **live** price IDs.
- Create a **live** notification destination (same URL + events) and set its live
  signing secret: `supabase secrets set PADDLE_WEBHOOK_SECRET=…`.
- Redeploy the frontend (Vercel) and the function.

## Not built yet (easy follow-ups)

- **Manage / cancel** from inside the app (Paddle customer-portal link).
- **Gating specific Pro features** — the plumbing is ready: `isProNow(sub)` on the
  client and `public.is_pro()` in SQL/RLS. Wrap whichever features are Pro-only.
