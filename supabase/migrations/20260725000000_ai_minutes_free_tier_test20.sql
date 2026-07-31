-- Test tier → 20 min (fast to hit while testing). Add a free-tier cap that only
-- applies when the caller passes p_free_min > 0 — so production (whose client
-- sends nothing) keeps beta-unlimited, while the 0.01 client can opt in.

create or replace function public.plan_minute_limit(p_plan text) returns int
language sql immutable as $$
  select case p_plan
    when 'test' then 20
    when 'starter' then 1200
    when 'pro' then 2500
    when 'unlimited' then 0
    else 0
  end
$$;

drop function if exists public.consume_ai_seconds(uuid, int);
create or replace function public.consume_ai_seconds(p_user uuid, p_seconds int default 0, p_free_min int default 0)
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

  if v_price is not null then
    v_plan := public.plan_of_price(v_price);
    v_limit_min := public.plan_minute_limit(coalesce(v_plan, ''));
  else
    -- No subscription → free tier. p_free_min <= 0 means unlimited (beta).
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
end $$;
revoke all on function public.consume_ai_seconds(uuid, int, int) from public;
grant execute on function public.consume_ai_seconds(uuid, int, int) to service_role;

drop function if exists public.ai_usage_status();
create or replace function public.ai_usage_status(p_free_min int default 0)
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
end $$;
grant execute on function public.ai_usage_status(int) to authenticated;
