-- EaseCutPro — Pro subscriptions (Paddle, Merchant of Record).
--
-- Paddle is the merchant of record: it captures cards worldwide and pays us out
-- (Payoneer → PK bank). This table holds only the entitlement state Paddle
-- reports over its webhook. The paddle-webhook edge function (service role) is
-- the ONLY writer; clients read their own row to gate Pro features but can
-- never write it, so entitlement can't be forged from the browser.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  paddle_customer_id text,
  paddle_subscription_id text unique,
  status text not null default 'inactive',   -- paddle: active|trialing|past_due|paused|canceled (+ our 'inactive')
  price_id text,
  product_id text,
  plan text,                                 -- optional label, e.g. 'pro-monthly' | 'pro-annual'
  current_period_end timestamptz,            -- access remains until here even after a scheduled cancel
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_customer on public.subscriptions (paddle_customer_id);

alter table public.subscriptions enable row level security;

-- Owner may READ their row. No insert/update/delete policies exist, so clients
-- cannot forge entitlement; the webhook writes with the service role (which
-- bypasses RLS).
create policy "subscriptions: read own" on public.subscriptions
  for select using (auth.uid() = user_id);

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- Is the signed-in user Pro right now? active/trialing and not past the paid
-- period. SECURITY DEFINER + hardcoded auth.uid() so it only ever reveals the
-- caller's own status, and can be reused inside other tables' RLS as
-- `using (public.is_pro())` when we start gating server-side.
create or replace function public.is_pro()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = auth.uid()
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;
