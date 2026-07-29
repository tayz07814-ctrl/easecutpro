-- Admin dashboard backend: an allowlist of admin users + SECURITY DEFINER RPCs
-- that read cross-user stats and manage the userbase (plan, block, notify).
-- Everything is gated on is_app_admin(); the browser client can only reach these
-- through the RPCs, never the underlying auth.users / other users' rows.

-- ── Admin allowlist ──────────────────────────────────────────────────────────
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;   -- no policies: definer-only

-- Seed the account owner as the first admin.
insert into public.app_admins(user_id)
values ('6349a291-05da-4f9e-8c06-1fbbb2a554eb') on conflict do nothing;

create or replace function public.is_app_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;
revoke execute on function public.is_app_admin() from anon;
grant execute on function public.is_app_admin() to authenticated;

-- ── Block ledger (reason/history; the real ban is auth.users.banned_until) ──
create table if not exists public.user_blocks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reason text,
  blocked_at timestamptz not null default now(),
  blocked_by uuid
);
alter table public.user_blocks enable row level security;   -- no policies: definer-only

-- ── Overview KPIs ────────────────────────────────────────────────────────────
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_app_admin() then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'total_users',    (select count(*) from auth.users),
    'new_7d',         (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'new_30d',        (select count(*) from auth.users where created_at > now() - interval '30 days'),
    'active_7d',      (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'pro_users',      (select count(*) from public.subscriptions
                        where status in ('active','trialing')
                          and (current_period_end is null or current_period_end > now())),
    'blocked_users',  (select count(*) from auth.users where banned_until is not null and banned_until > now()),
    'total_projects', (select count(*) from public.projects),
    'total_spaces',   (select count(*) from public.spaces),
    'storage_bytes',  (select coalesce(sum(media_bytes),0) from public.space_projects),
    'ai_runs_total',  (select coalesce(sum(ai_runs),0) from public.usage)
  ) into v;
  return v;
end; $$;

-- ── Per-user list with all stats (search + pagination) ───────────────────────
create or replace function public.admin_list_users(
  p_search text default '', p_limit int default 100, p_offset int default 0)
returns table(
  user_id uuid, email text, username text, display_name text,
  created_at timestamptz, last_sign_in_at timestamptz,
  plan text, sub_status text, current_period_end timestamptz, days_left int,
  ai_runs int, project_count bigint, space_count bigint, storage_bytes bigint,
  blocked boolean, block_reason text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_app_admin() then raise exception 'forbidden'; end if;
  return query
  select u.id,
         coalesce(p.email, u.email),
         p.username, p.display_name,
         u.created_at, u.last_sign_in_at,
         coalesce(s.plan, 'free'), s.status, s.current_period_end,
         case when s.status in ('active','trialing') and s.current_period_end is not null
              then greatest(0, ceil(extract(epoch from (s.current_period_end - now()))/86400))::int
              else null end,
         coalesce(us.ai_runs, 0),
         (select count(*) from public.projects pr where pr.user_id = u.id),
         (select count(*) from public.spaces sp where sp.owner_id = u.id),
         (select coalesce(sum(spj.media_bytes),0)
            from public.spaces sp join public.space_projects spj on spj.space_id = sp.id
           where sp.owner_id = u.id),
         (u.banned_until is not null and u.banned_until > now()),
         b.reason
  from auth.users u
  left join public.profiles p       on p.id = u.id
  left join public.subscriptions s  on s.user_id = u.id
  left join public.usage us         on us.user_id = u.id
  left join public.user_blocks b    on b.user_id = u.id
  where p_search = ''
     or u.email        ilike '%'||p_search||'%'
     or p.username     ilike '%'||p_search||'%'
     or p.display_name ilike '%'||p_search||'%'
  order by u.created_at desc
  limit greatest(1, least(p_limit, 500)) offset greatest(0, p_offset);
end; $$;

-- ── Set/clear a user's plan (manual comp or fix; the Paddle webhook still owns
-- ── automated billing). p_days_from_now null = no expiry. ────────────────────
create or replace function public.admin_set_plan(
  p_user uuid, p_plan text, p_status text default 'active', p_days_from_now int default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_end timestamptz;
begin
  if not public.is_app_admin() then raise exception 'forbidden'; end if;
  v_end := case when p_days_from_now is not null then now() + make_interval(days => p_days_from_now) else null end;
  if p_plan = 'free' and p_status is distinct from 'active' then
    -- downgrade to free: mark canceled (is_pro() then returns false)
    update public.subscriptions set plan='free', status='canceled', updated_at=now() where user_id = p_user;
    if not found then
      insert into public.subscriptions(user_id, plan, status, updated_at)
      values (p_user, 'free', 'canceled', now());
    end if;
  else
    insert into public.subscriptions(user_id, plan, status, current_period_end, updated_at)
    values (p_user, p_plan, p_status, v_end, now())
    on conflict (user_id) do update
      set plan = excluded.plan, status = excluded.status,
          current_period_end = excluded.current_period_end, updated_at = now();
  end if;
  return 'ok';
end; $$;

-- ── Block / unblock (real: auth.users.banned_until → GoTrue rejects the JWT) ──
create or replace function public.admin_block(p_user uuid, p_block boolean, p_reason text default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_admin() then raise exception 'forbidden'; end if;
  if p_user = auth.uid() then raise exception 'refusing to block the acting admin'; end if;
  if p_block then
    update auth.users set banned_until = 'infinity' where id = p_user;
    insert into public.user_blocks(user_id, reason, blocked_at, blocked_by)
    values (p_user, p_reason, now(), auth.uid())
    on conflict (user_id) do update set reason = excluded.reason, blocked_at = now(), blocked_by = auth.uid();
  else
    update auth.users set banned_until = null where id = p_user;
    delete from public.user_blocks where user_id = p_user;
  end if;
  return 'ok';
end; $$;

-- ── Notifications: to one user, or broadcast to everyone ─────────────────────
create or replace function public.admin_notify(p_user uuid, p_message text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_admin() then raise exception 'forbidden'; end if;
  insert into public.notifications(user_id, kind, from_name, message)
  values (p_user, 'admin', 'EaseCut Team', p_message);
  return 'ok';
end; $$;

create or replace function public.admin_broadcast(p_message text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_app_admin() then raise exception 'forbidden'; end if;
  insert into public.notifications(user_id, kind, from_name, message)
  select id, 'admin', 'EaseCut Team', p_message from auth.users;
  get diagnostics n = row_count;
  return n;
end; $$;

-- Only signed-in users may call; each RPC self-checks is_app_admin() so a
-- non-admin gets 'forbidden'. Never grant to anon.
revoke execute on function
  public.admin_overview(), public.admin_list_users(text,int,int),
  public.admin_set_plan(uuid,text,text,int), public.admin_block(uuid,boolean,text),
  public.admin_notify(uuid,text), public.admin_broadcast(text)
  from anon, public;
grant execute on function
  public.admin_overview(), public.admin_list_users(text,int,int),
  public.admin_set_plan(uuid,text,text,int), public.admin_block(uuid,boolean,text),
  public.admin_notify(uuid,text), public.admin_broadcast(text)
  to authenticated;
