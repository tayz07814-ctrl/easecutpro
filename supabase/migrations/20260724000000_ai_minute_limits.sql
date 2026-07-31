-- Per-plan AI-minute metering (per billing cycle). Additive: existing
-- consume_ai_run / ai_run_limit are untouched. Enforcement only bites users with
-- an active subscription; no-subscription users stay unlimited (beta).

alter table public.usage
  add column if not exists ai_seconds bigint not null default 0,
  add column if not exists period_end timestamptz;

-- Minutes allowed per billing cycle, by plan. 0 = no cap (unlimited plan, or an
-- unrecognised/absent plan = free-beta unlimited for now).
create or replace function public.plan_minute_limit(p_plan text) returns int
language sql immutable as $$
  select case p_plan
    when 'test' then 100
    when 'starter' then 1200
    when 'pro' then 2500
    when 'unlimited' then 0
    else 0
  end
$$;

-- Stripe price id -> plan name (live EaseCut account).
create or replace function public.plan_of_price(p_price text) returns text
language sql immutable as $$
  select case p_price
    when 'price_1Tz4cy2MO59VUOO6Mvc8IYjg' then 'starter'
    when 'price_1Tz4cy2MO59VUOO6qw7TnZ7a' then 'pro'
    when 'price_1Tz4cz2MO59VUOO6ocs469LB' then 'unlimited'
    when 'price_1Tz4oy2MO59VUOO67qsVtvTZ' then 'test'
    else null
  end
$$;

-- Check (and charge) a run's seconds against the user's plan cap for the current
-- billing cycle. Resets when the subscription period rolls over. Called by the
-- stt edge function with the service role.
create or replace function public.consume_ai_seconds(p_user uuid, p_seconds int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_price text; v_period_end timestamptz; v_plan text;
  v_limit_min int; v_limit_sec bigint; v_used bigint; v_stored_period timestamptz;
begin
  select s.price_id, s.current_period_end into v_price, v_period_end
  from public.subscriptions s
  where s.user_id = p_user and s.status in ('active','trialing')
    and (s.current_period_end is null or s.current_period_end > now())
  order by s.current_period_end desc nulls last limit 1;

  v_plan := public.plan_of_price(v_price);
  v_limit_min := public.plan_minute_limit(coalesce(v_plan, ''));

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
end $$;
revoke all on function public.consume_ai_seconds(uuid, int) from public;
grant execute on function public.consume_ai_seconds(uuid, int) to service_role;

-- Read-only usage for the account panel (caller's own row).
create or replace function public.ai_usage_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_price text; v_period_end timestamptz;
  v_plan text; v_limit_min int; v_used bigint; v_stored_period timestamptz;
begin
  if v_uid is null then return jsonb_build_object('signed_in', false); end if;
  select s.price_id, s.current_period_end into v_price, v_period_end
  from public.subscriptions s
  where s.user_id = v_uid and s.status in ('active','trialing')
    and (s.current_period_end is null or s.current_period_end > now())
  order by s.current_period_end desc nulls last limit 1;
  v_plan := public.plan_of_price(v_price);
  v_limit_min := public.plan_minute_limit(coalesce(v_plan, ''));
  select ai_seconds, period_end into v_used, v_stored_period from public.usage where user_id = v_uid;
  if v_stored_period is distinct from v_period_end then v_used := 0; end if;
  return jsonb_build_object(
    'signed_in', true, 'plan', v_plan, 'limit_minutes', v_limit_min,
    'unlimited', v_limit_min <= 0, 'used_minutes', floor(coalesce(v_used, 0) / 60.0), 'period_end', v_period_end
  );
end $$;
grant execute on function public.ai_usage_status() to authenticated;
