-- Stripe subscription columns (migrating the processor from Paddle to Stripe).
-- subscriptions stays the entitlement store; only the id/customer columns are
-- provider-specific. status / price_id / current_period_end / cancel_at_period_end
-- and is_pro() are unchanged and provider-agnostic.
alter table public.subscriptions
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;
create index if not exists subscriptions_stripe_customer on public.subscriptions (stripe_customer_id);
