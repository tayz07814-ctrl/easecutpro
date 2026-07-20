-- Disable the free-trial run limit during private beta.
--
-- Beta testers get UNLIMITED AI runs. ai_run_limit() is the single switch: a
-- value <= 0 means "trials disabled / unlimited". consume_ai_run() then always
-- allows (and never counts), and the account panel reads the limit to hide the
-- "X of N" trial bar. To re-enable when the product goes public, set the limit
-- back to a positive number (e.g. `select 5`) — nothing else needs to change.

create or replace function public.ai_run_limit() returns int language sql immutable as $$ select 0 $$;

-- Let the browser read the current allowance (public, non-sensitive) so the
-- account panel can reflect "unlimited during beta" vs "X of N used".
grant execute on function public.ai_run_limit() to authenticated, anon;

-- Treat a non-positive limit as unlimited: always allowed, never counted. The
-- rest of the logic (Pro = unlimited, per-user count) is unchanged for when the
-- limit is put back to a positive number.
create or replace function public.consume_ai_run(p_user uuid, p_increment boolean default true)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_pro boolean;
  v_used int;
  v_limit int := public.ai_run_limit();
begin
  -- Trials disabled (beta) → unlimited for everyone, nothing recorded.
  if v_limit <= 0 then
    return jsonb_build_object('allowed', true, 'pro', false, 'used', 0, 'limit', v_limit, 'trial_enabled', false);
  end if;

  select exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  ) into v_pro;

  if v_pro then
    return jsonb_build_object('allowed', true, 'pro', true, 'used', 0, 'limit', v_limit, 'trial_enabled', true);
  end if;

  insert into public.usage (user_id) values (p_user) on conflict (user_id) do nothing;
  select ai_runs into v_used from public.usage where user_id = p_user for update;

  if v_used >= v_limit then
    return jsonb_build_object('allowed', false, 'pro', false, 'used', v_used, 'limit', v_limit, 'trial_enabled', true);
  end if;

  if p_increment then
    update public.usage set ai_runs = ai_runs + 1, updated_at = now() where user_id = p_user;
    v_used := v_used + 1;
  end if;

  return jsonb_build_object('allowed', true, 'pro', false, 'used', v_used, 'limit', v_limit, 'trial_enabled', true);
end;
$$;

-- consume_ai_run takes an arbitrary user id and is SECURITY DEFINER, so it stays
-- callable ONLY by the service role (the edge functions) — never by end users.
revoke all on function public.consume_ai_run(uuid, boolean) from public;
grant execute on function public.consume_ai_run(uuid, boolean) to service_role;
