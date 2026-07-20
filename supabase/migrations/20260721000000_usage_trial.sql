-- Free-trial usage metering. Every account gets N free AI runs (one run = one
-- AI transcription/auto-clean); after that they must subscribe. Enforced
-- server-side in the stt edge function via consume_ai_run() — the browser can't
-- bypass it. The account panel reads public.usage to show "X of N used".

create table if not exists public.usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ai_runs int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.usage enable row level security;
-- Owner may READ their own usage (for the account panel). No client write policy —
-- only consume_ai_run (service role) mutates it, so the count can't be forged.
drop policy if exists "usage: read own" on public.usage;
create policy "usage: read own" on public.usage for select using (auth.uid() = user_id);

-- The free-run allowance (one place to change it).
create or replace function public.ai_run_limit() returns int language sql immutable as $$ select 5 $$;

-- Atomically check (and optionally increment) a user's AI-run usage. Pro users
-- are always allowed and never counted. Returns { allowed, pro, used, limit }.
-- Called by edge functions with the service role, passing the user id.
create or replace function public.consume_ai_run(p_user uuid, p_increment boolean default true)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_pro boolean;
  v_used int;
  v_limit int := public.ai_run_limit();
begin
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  ) into v_pro;

  if v_pro then
    return jsonb_build_object('allowed', true, 'pro', true, 'used', 0, 'limit', v_limit);
  end if;

  insert into public.usage (user_id) values (p_user) on conflict (user_id) do nothing;
  select ai_runs into v_used from public.usage where user_id = p_user for update;

  if v_used >= v_limit then
    return jsonb_build_object('allowed', false, 'pro', false, 'used', v_used, 'limit', v_limit);
  end if;

  if p_increment then
    update public.usage set ai_runs = ai_runs + 1, updated_at = now() where user_id = p_user;
    v_used := v_used + 1;
  end if;

  return jsonb_build_object('allowed', true, 'pro', false, 'used', v_used, 'limit', v_limit);
end;
$$;

-- consume_ai_run takes an arbitrary user id and is SECURITY DEFINER, so it must
-- be callable ONLY by the service role (the edge functions) — never by end users.
revoke all on function public.consume_ai_run(uuid, boolean) from public;
grant execute on function public.consume_ai_run(uuid, boolean) to service_role;
