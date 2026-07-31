-- Grandfather every user who signed up before the paywall: unlimited AI minutes.
--
-- APPLIED LIVE. The minute gate (consume_ai_seconds) caps free-tier users at
-- whatever the client passes as p_free_min (0.01 sends 20). Beta users signed up
-- when everything was unlimited, so capping them retroactively would break
-- accounts that were never sold a limit. This grants them unlimited EXPLICITLY
-- rather than relying on the client to keep sending p_free_min = 0.
--
-- Scope at apply time: all 23 existing users. Future signups are NOT granted, so
-- the paywall still applies to them.

create table if not exists public.ai_unlimited (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  reason     text not null default 'grandfathered'
);

-- No policies, on purpose: a user who could INSERT here would be granting
-- themselves unlimited AI. Only SECURITY DEFINER functions (and service_role,
-- which bypasses RLS) may read or write it.
alter table public.ai_unlimited enable row level security;
revoke all on public.ai_unlimited from anon, authenticated;

insert into public.ai_unlimited (user_id, reason)
select id, 'grandfathered: signed up before the paywall'
from auth.users
on conflict (user_id) do nothing;

-- The gate honours the grant ahead of any plan lookup, so it holds whether or
-- not the user later subscribes.
create or replace function public.consume_ai_seconds(p_user uuid, p_seconds integer default 0, p_free_min integer default 0)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_price text; v_period_end timestamptz; v_plan text;
  v_limit_min int; v_limit_sec bigint; v_used bigint; v_stored_period timestamptz;
begin
  -- Grandfathered beta users: unlimited, never metered, no usage row touched.
  if exists (select 1 from public.ai_unlimited g where g.user_id = p_user) then
    return jsonb_build_object('allowed', true, 'plan', 'grandfathered', 'used_seconds', 0, 'limit_minutes', 0, 'unlimited', true);
  end if;

  select s.price_id, s.current_period_end into v_price, v_period_end
  from public.subscriptions s
  where s.user_id = p_user and s.status in ('active','trialing')
    and (s.current_period_end is null or s.current_period_end > now())
  order by s.current_period_end desc nulls last limit 1;

  if v_price is not null then
    v_plan := public.plan_of_price(v_price);
    v_limit_min := public.plan_minute_limit(coalesce(v_plan, ''));
  else
    -- No subscription -> free tier. p_free_min <= 0 means unlimited (beta).
    v_plan := null;
    v_limit_min := greatest(coalesce(p_free_min, 0), 0);
    v_period_end := null; -- free tier is a lifetime bucket (no billing cycle)
  end if;

  if v_limit_min <= 0 then
    return jsonb_build_object('allowed', true, 'plan', v_plan, 'used_seconds', 0, 'limit_minutes', 0, 'unlimited', true);
  end if;

  v_limit_sec := v_limit_min::bigint * 60;
  insert into public.usage (user_id) values (p_user) on conflict (user_id) do nothing;
  select ai_seconds, period_end into v_used, v_stored_period from public.usage where user_id = p_user for update;

  if v_stored_period is distinct from v_period_end then
    v_used := 0;
    update public.usage set ai_seconds = 0, period_end = v_period_end, updated_at = now() where user_id = p_user;
  end if;

  if v_used >= v_limit_sec then
    return jsonb_build_object('allowed', false, 'plan', v_plan, 'used_seconds', v_used, 'limit_minutes', v_limit_min, 'unlimited', false);
  end if;

  if p_seconds > 0 then
    update public.usage set ai_seconds = ai_seconds + p_seconds, updated_at = now() where user_id = p_user;
    v_used := v_used + p_seconds;
  end if;

  return jsonb_build_object('allowed', true, 'plan', v_plan, 'used_seconds', v_used, 'limit_minutes', v_limit_min, 'unlimited', false);
end $function$;

-- The account panel must agree with the gate, or a grandfathered user sees
-- "0 / 20 minutes" while the backend is letting everything through.
create or replace function public.ai_usage_status(p_free_min integer default 0)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid(); v_price text; v_period_end timestamptz;
  v_plan text; v_limit_min int; v_used bigint; v_stored_period timestamptz;
begin
  if v_uid is null then return jsonb_build_object('signed_in', false); end if;

  if exists (select 1 from public.ai_unlimited g where g.user_id = v_uid) then
    return jsonb_build_object(
      'signed_in', true, 'plan', 'grandfathered', 'limit_minutes', 0,
      'unlimited', true, 'used_minutes', 0, 'period_end', null
    );
  end if;

  select s.price_id, s.current_period_end into v_price, v_period_end
  from public.subscriptions s
  where s.user_id = v_uid and s.status in ('active','trialing')
    and (s.current_period_end is null or s.current_period_end > now())
  order by s.current_period_end desc nulls last limit 1;
  if v_price is not null then
    v_plan := public.plan_of_price(v_price);
    v_limit_min := public.plan_minute_limit(coalesce(v_plan, ''));
  else
    v_plan := null; v_limit_min := greatest(coalesce(p_free_min, 0), 0); v_period_end := null;
  end if;
  select ai_seconds, period_end into v_used, v_stored_period from public.usage where user_id = v_uid;
  if v_stored_period is distinct from v_period_end then v_used := 0; end if;
  return jsonb_build_object(
    'signed_in', true, 'plan', v_plan, 'limit_minutes', v_limit_min,
    'unlimited', v_limit_min <= 0, 'used_minutes', floor(coalesce(v_used, 0) / 60.0), 'period_end', v_period_end
  );
end $function$;

-- Grant/revoke from the admin console. Admin-gated like every other admin_* RPC.
create or replace function public.admin_set_unlimited(p_user uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_app_admin() then raise exception 'not authorized'; end if;
  if p_on then
    insert into public.ai_unlimited (user_id, reason) values (p_user, 'granted by admin')
    on conflict (user_id) do nothing;
  else
    delete from public.ai_unlimited where user_id = p_user;
  end if;
end $function$;

revoke all on function public.admin_set_unlimited(uuid, boolean) from anon;
grant execute on function public.admin_set_unlimited(uuid, boolean) to authenticated;
