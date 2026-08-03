-- AI credit ledger + space-creation guard.
--
-- Two holes this closes:
--
--   1. The ten LLM/vision judge functions call OpenRouter with no server-side
--      cap of any kind. consume_ai_seconds meters STT minutes, but nothing
--      meters judge calls, so one scripted client can burn the AI budget.
--
--   2. public.spaces freezes quota_bytes/is_paid on UPDATE (spaces_freeze_billing)
--      but INSERT was unguarded: a client could create a space with any quota it
--      liked, as many times as it liked.
--
-- Grandfathered beta users (public.ai_unlimited) stay unlimited everywhere.

-- ---------------------------------------------------------------------------
-- 1. Per-plan daily judge-credit allowance
-- ---------------------------------------------------------------------------
-- Mirrors plan_minute_limit, including its convention that 0 means unlimited.
-- One credit is one cheap text-judge call; the vision functions charge more per
-- call (the weight is chosen server-side in the edge helper, never by the client).
-- A NULL/unknown plan is the free tier, which is where fresh signups land.
create or replace function public.plan_credit_limit(p_plan text)
returns integer
language sql
immutable
as $$
  select case p_plan
    when 'test' then 40
    when 'starter' then 400
    when 'pro' then 1000
    when 'unlimited' then 0
    else 20
  end
$$;

-- ---------------------------------------------------------------------------
-- 2. The ledger
-- ---------------------------------------------------------------------------
create table if not exists public.ai_daily_credits (
  user_id    uuid not null references auth.users(id) on delete cascade,
  day        date not null,
  credits    integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Server-owned. RLS on with no policies at all, so PostgREST can never reach it
-- as anon or authenticated; only the SECURITY DEFINER function below and the
-- service role touch these rows.
alter table public.ai_daily_credits enable row level security;
revoke all on public.ai_daily_credits from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Charge credits, atomically, before the work is done
-- ---------------------------------------------------------------------------
create or replace function public.charge_ai_credits(p_user uuid, p_credits integer default 1)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_day   date := (now() at time zone 'utc')::date;
  v_cost  integer := greatest(coalesce(p_credits, 1), 1);
  v_price text;
  v_plan  text;
  v_limit integer;
  v_after integer;
begin
  if p_user is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_user');
  end if;

  -- Grandfathered beta users: unlimited, never metered, no ledger row touched.
  if exists (select 1 from public.ai_unlimited g where g.user_id = p_user) then
    return jsonb_build_object('allowed', true, 'unlimited', true, 'plan', 'grandfathered');
  end if;

  select s.price_id into v_price
  from public.subscriptions s
  where s.user_id = p_user
    and s.status in ('active', 'trialing')
    and (s.current_period_end is null or s.current_period_end > now())
  order by s.current_period_end desc nulls last
  limit 1;

  -- plan_of_price returns null for an unknown/absent price, and a null plan
  -- falls through plan_credit_limit's CASE to the free-tier allowance.
  v_plan  := public.plan_of_price(coalesce(v_price, ''));
  v_limit := public.plan_credit_limit(v_plan);

  if v_limit <= 0 then
    return jsonb_build_object('allowed', true, 'unlimited', true, 'plan', v_plan);
  end if;

  -- A call costing more than the whole day's allowance can never be afforded.
  -- Reject it here: the INSERT's no-conflict path has no cap check, so the
  -- first call of the day would otherwise slip through at any price.
  if v_cost > v_limit then
    return jsonb_build_object('allowed', false, 'used', 0, 'limit', v_limit,
                              'plan', v_plan, 'unlimited', false);
  end if;

  -- One statement, so concurrent judge calls cannot race past the cap: the
  -- WHERE on DO UPDATE turns an over-cap charge into a no-op that returns no
  -- row, which is the deny signal.
  insert into public.ai_daily_credits as c (user_id, day, credits)
  values (p_user, v_day, v_cost)
  on conflict (user_id, day) do update
    set credits = c.credits + v_cost, updated_at = now()
    where c.credits + v_cost <= v_limit
  returning c.credits into v_after;

  if v_after is null then
    select credits into v_after
    from public.ai_daily_credits
    where user_id = p_user and day = v_day;
    return jsonb_build_object('allowed', false, 'used', coalesce(v_after, 0),
                              'limit', v_limit, 'plan', v_plan, 'unlimited', false);
  end if;

  return jsonb_build_object('allowed', true, 'used', v_after, 'limit', v_limit,
                            'plan', v_plan, 'unlimited', false);
end
$$;

-- Only the service role (the edge functions) may charge credits.
revoke all on function public.charge_ai_credits(uuid, integer) from public, anon, authenticated;

-- Read-only view of your own balance, for the UI.
create or replace function public.my_ai_credits()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_price text; v_plan text; v_limit integer; v_used integer;
begin
  if v_user is null then
    return jsonb_build_object('used', 0, 'limit', 0, 'unlimited', false);
  end if;
  if exists (select 1 from public.ai_unlimited g where g.user_id = v_user) then
    return jsonb_build_object('used', 0, 'limit', 0, 'unlimited', true, 'plan', 'grandfathered');
  end if;
  select s.price_id into v_price
  from public.subscriptions s
  where s.user_id = v_user
    and s.status in ('active', 'trialing')
    and (s.current_period_end is null or s.current_period_end > now())
  order by s.current_period_end desc nulls last
  limit 1;
  v_plan  := public.plan_of_price(coalesce(v_price, ''));
  v_limit := public.plan_credit_limit(v_plan);
  select coalesce(credits, 0) into v_used
  from public.ai_daily_credits
  where user_id = v_user and day = (now() at time zone 'utc')::date;
  return jsonb_build_object('used', coalesce(v_used, 0), 'limit', v_limit,
                            'unlimited', v_limit <= 0, 'plan', v_plan);
end
$$;

revoke all on function public.my_ai_credits() from public, anon;
grant execute on function public.my_ai_credits() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. spaces: guard INSERT the way spaces_freeze_billing guards UPDATE
-- ---------------------------------------------------------------------------
create or replace function public.spaces_guard_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_owned integer;
begin
  if current_user in ('authenticated', 'anon') then
    -- Clients never choose their own quota, paid flag, or owner.
    new.quota_bytes := 107374182400;  -- 100 GiB, the column default
    new.is_paid := false;
    new.owner_id := auth.uid();

    select count(*) into v_owned from public.spaces s where s.owner_id = auth.uid();
    if v_owned >= 10 then
      raise exception 'space limit reached (10 per account)' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists spaces_guard_new on public.spaces;
create trigger spaces_guard_new
  before insert on public.spaces
  for each row execute function public.spaces_guard_insert();
