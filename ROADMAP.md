# EaseCutPro — Road to Public Launch

Target: cloud app (easecutpro on Vercel + Supabase) publicly launched, taking
real money through Paddle. Desktop app ships later as a follow-up (license
keys), not in this launch.

Rough total: **~2–3 weeks**, dominated by two external clocks (Paddle live
approval + Payoneer verification) that we start immediately and work in
parallel with everything else.

Legend: **[you]** = needs your accounts/hands · **[claude]** = I build it ·
**[ext]** = external party's clock.

---

## Phase 0 — Close the revenue loop (today, ~1 hour)

The sandbox checkout works end-to-end EXCEPT the webhook → Pro flip. Until a
paid test flips the ★ Pro badge, nothing else on this list matters.

- [ ] **[you]** Paddle sandbox → Developer Tools → Notifications: destination
      exists, URL is `https://zlqxrdlognjvwqpmnfjq.supabase.co/functions/v1/paddle-webhook`,
      all `subscription.*` events ticked.
- [ ] **[you]** Supabase → Edge Functions → Secrets: `PADDLE_WEBHOOK_SECRET` =
      that destination's secret key (`pdl_ntfset_…`).
- [ ] **[claude]** Pull edge-function logs, diagnose any 401/500, re-test until a
      sandbox payment writes a `subscriptions` row and the badge flips to ★ Pro.
- [ ] **[claude]** Fix the outstanding security advisory: enable RLS on
      `public.delta_debug` (currently world-writable via the anon key).

## Phase 1 — Start the external clocks (this week, in parallel)

These have days-to-weeks lead times. Everything else happens while they tick.

- [ ] **[you+ext]** **Payoneer** account fully verified (payout rail to your PK
      bank). Free; do it first.
- [ ] **[you+ext]** **Paddle LIVE account application.** Paddle reviews your
      live site before approving — it needs the real domain with pricing,
      Terms, Privacy, and Refund pages visible (Phase 2 makes those). Expect
      days to ~2 weeks; this is the launch date's long pole.
- [ ] **[you]** **Buy the domain** (e.g. easecutpro.com) and point it at the
      Vercel project. A custom domain smooths Paddle approval and is required
      for a branded email sender later.

## Phase 2 — Landing page, pricing, legal (2–4 days) **[claude]**

The public face. Signed-out visitors get a marketing page; the app stays where
it is for signed-in users.

- [ ] Landing page: hero + demo video (dogfood it — cut the demo IN EaseCutPro),
      feature sections (transcript editing, silence removal, Retake β, overlays,
      on-device export = privacy angle), social proof slot, FAQ.
- [ ] Pricing page/section: Free vs Pro table, monthly + annual toggle.
      **[you]** create the annual price in Paddle (suggest ~$96/yr ≈ 33% off
      the $12/mo) and send me the `pri_…`.
- [ ] Legal pages: Terms of Service, Privacy Policy, Refund Policy (Paddle
      handles refunds as merchant of record — the page states the policy).
      Required for Paddle live approval.
- [ ] SEO/meta: titles, descriptions, OG/social cards, favicon, sitemap.

## Phase 3 — Make Pro mean something (2–3 days) **[claude]**

Today every feature is free. Decide the split, then I wire the gates
(client: `isProNow()`; server: `public.is_pro()` in RLS/edge functions so it
can't be bypassed).

Proposed split (adjust freely):

| | Free | Pro |
|---|---|---|
| Projects | 3 | Unlimited |
| Transcription | 30 min/month | 10 hrs/month |
| Core editing, silence removal, export | ✓ | ✓ |
| Retake β / ProCut / AI overlays / Batch cleaner | — | ✓ |

- [ ] Usage metering table + monthly transcription quota enforced **in the STT
      edge function** (server-side — this is what caps your AssemblyAI/
      Deepgram/Anthropic bill when free traffic spikes).
- [ ] Gate the Pro engines in UI + edge functions.
- [ ] Upgrade prompts where free users hit limits (the actual conversion moments).

## Phase 4 — Production hardening (2–3 days) **[claude]**, small **[you]** bits

- [ ] Merge the payment branch → `main` once Phase 0 is green.
- [ ] Custom SMTP for Supabase auth emails (e.g. Resend, free tier) — default
      Supabase email is rate-limited (~4/hr) and will break signups on launch
      day. **[you]**: create the Resend account + verify the domain.
- [ ] Error tracking (Sentry) + product analytics (PostHog or Plausible) —
      launch blind = learn nothing.
- [ ] **[you]** Supabase Pro plan ($25/mo) before launch — free-tier limits +
      launch traffic don't mix. Set spend alerts on AssemblyAI/Deepgram/
      Anthropic/Supabase.
- [ ] support@ email address (Paddle requires a support contact; put it in the
      site footer).
- [ ] Mobile pass on landing + auth pages.
- [ ] Paddle LIVE switch-over (once approved): live client token + live price
      IDs + `VITE_PADDLE_ENV=production` in Vercel env vars; live notification
      destination + its secret in Supabase; approve the production domain.
      Sandbox defaults in code remain the fallback for previews only.

## Phase 5 — Private beta soak (3–7 days, overlaps Phase 4)

- [ ] **[you]** 10–20 real creators (Twitter/X DMs, Discords, friends). Watch
      them use it; I fix what breaks daily.
- [ ] Watch edge-function logs + provider spend with real usage patterns.
- [ ] One full real-money test on live Paddle (then refund it) before launch day.

## Phase 6 — Launch (1 day + the week after)

Channel plan — it's a creator tool, so SHOW it:
- [ ] Demo videos: 3–5 short clips (TikTok/Shorts/X) of the magic moment —
      delete words → video cuts itself. Made in EaseCutPro, say so.
- [ ] Product Hunt launch (prep gallery, first comment, hunter).
- [ ] Show HN + Reddit (r/NewTubers, r/VideoEditing, r/SideProject) — each
      written natively for the community, not cross-posted spam.
- [ ] X build-in-public thread: Pakistan founder story + Paddle/MoR angle is
      genuinely interesting content.
- [ ] Launch offer: Paddle discount code (e.g. 30% off first 100 subscribers).
- [ ] Launch-day watch: logs, Sentry, support inbox; hotfix on sight.

## Post-launch backlog (week 2+)

- Manage/cancel subscription in-app (Paddle customer portal link).
- Onboarding polish based on where beta users stall.
- SEO content + "EaseCutPro vs Descript" comparison page.
- Desktop app: package + Paddle license keys (one-time or same subscription).
- Mobile apps (Capacitor shell already in repo) — same Supabase backend.

---

## Critical path (what actually orders the calendar)

```
Phase 0 (hours) ──▶ merge to main ─▶ Phase 3 gating ─▶ Phase 4 hardening ─▶ beta ─▶ LAUNCH
Phase 1 Paddle live application ────────(external clock)───────────▲
Phase 1 Payoneer verification ──────────(external clock)───────────┘
Phase 2 landing/legal (needed BEFORE Paddle can approve the live site)
```

The launch date is set by **Paddle live approval**, and Paddle can't approve
until the **site with pricing + legal pages is live** — so Phases 1+2 start
now, not after the product work.
