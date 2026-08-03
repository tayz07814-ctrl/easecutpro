-- Close a hole the two previous ledger migrations left open.
--
-- Both of them "locked down" the ledger's write functions like this:
--
--     revoke all on function ... from public;
--     revoke all on function ... from authenticated;
--
-- That is not enough. In Postgres, PUBLIC is a pseudo-role, and revoking from it
-- removes only the PUBLIC grant — it does not touch an EXPLICIT grant to a named
-- role. Supabase's default privileges explicitly grant EXECUTE on every new
-- function in `public` to anon, authenticated and service_role. So `anon=X` was
-- left standing on both functions, and `anon` is the role PostgREST uses for the
-- anon key that ships inside the client bundle.
--
-- Verified against production before this migration: an unauthenticated request
-- carrying only the public anon key reached the body of both functions
-- (space_reserve_object returned P0001 'no such space' rather than 42501, and
-- space_commit_object returned false with HTTP 200). That made the storage quota
-- self-service again:
--
--   * space_reserve_object(space, key, 0) rewrites an existing row's byte count
--     to zero — upload 10 TB, then zero every row, and space_used_bytes reads 0.
--     That is exactly the hole the ledger was built to close, reopened one role
--     to the left.
--   * space_commit_object(key) pins any reserved row as permanently committed,
--     so a stranger's abandoned uploads never age out of their quota.
--
-- Two locks, because getting the grant wrong once already cost us this:
--   1. take the grant away from every role except service_role (and the owner);
--   2. refuse inside the function body if the request's JWT names a browser role,
--      so a future `grant execute ... to authenticated` can't quietly undo it.

-- Which role PostgREST switched to for this request: 'anon', 'authenticated',
-- 'service_role', or '' for a direct database connection (psql, migrations),
-- which already requires database credentials and is therefore trusted.
-- STABLE, not IMMUTABLE: the answer changes per request.
create or replace function public.ec_request_role()
returns text
language plpgsql
stable
set search_path = public
as $$
declare v text;
begin
  begin
    v := coalesce((current_setting('request.jwt.claims', true))::jsonb ->> 'role', '');
  exception when others then
    -- unset or not JSON — treat as a direct connection
    v := '';
  end;
  return v;
end $$;

revoke all on function public.ec_request_role() from public;
revoke all on function public.ec_request_role() from anon;
revoke all on function public.ec_request_role() from authenticated;

-- Reserve, now with the caller check. Body is otherwise unchanged from
-- 20260803000001_r2_object_ledger.sql.
create or replace function public.space_reserve_object(p_space uuid, p_key text, p_bytes bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quota bigint;
  v_used  bigint;
  v_prev  bigint;
begin
  if public.ec_request_role() not in ('', 'service_role') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  select quota_bytes into v_quota from public.spaces where id = p_space;
  if v_quota is null then
    raise exception 'no such space';
  end if;

  -- What this key already costs — an overwrite replaces, it doesn't add.
  select coalesce(bytes, 0) into v_prev
  from public.space_objects where space_id = p_space and key = p_key;
  v_prev := coalesce(v_prev, 0);

  v_used := public.space_used_bytes(p_space);

  if (v_used - v_prev + p_bytes) > v_quota then
    raise exception 'quota_exceeded' using errcode = 'check_violation';
  end if;

  insert into public.space_objects (space_id, key, bytes, state, updated_at)
  values (p_space, p_key, p_bytes, 'reserved', now())
  on conflict (space_id, key)
  do update set bytes = excluded.bytes, state = 'reserved', updated_at = now();

  return v_used - v_prev + p_bytes;
end;
$$;

create or replace function public.space_commit_object(p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if public.ec_request_role() not in ('', 'service_role') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;

  update public.space_objects
     set state = 'committed', updated_at = now()
   where key = p_key and state <> 'committed';
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Reading usage is fine for a member — but only for a space they belong to.
-- Without the membership test any signed-in user could measure any space they
-- could name. Service-role callers (the r2-sign edge function, which has already
-- checked membership itself) skip it.
create or replace function public.space_used_bytes(p_space uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_role text := public.ec_request_role();
begin
  if v_role not in ('', 'service_role') then
    if not exists (
      select 1 from public.space_members m where m.space_id = p_space and m.user_id = auth.uid()
    ) and not exists (
      select 1 from public.spaces s where s.id = p_space and s.owner_id = auth.uid()
    ) then
      raise exception 'not a member of this space' using errcode = 'insufficient_privilege';
    end if;
  end if;

  return (
    select coalesce(sum(bytes), 0)::bigint
    from public.space_objects
    where space_id = p_space
      and (state = 'committed' or updated_at > now() - interval '24 hours')
  );
end $$;

-- The grants themselves. `from public` alone was the original mistake; every
-- browser-reachable role is now named explicitly.
revoke all on function public.space_reserve_object(uuid, text, bigint) from public;
revoke all on function public.space_reserve_object(uuid, text, bigint) from anon;
revoke all on function public.space_reserve_object(uuid, text, bigint) from authenticated;
grant execute on function public.space_reserve_object(uuid, text, bigint) to service_role;

revoke all on function public.space_commit_object(text) from public;
revoke all on function public.space_commit_object(text) from anon;
revoke all on function public.space_commit_object(text) from authenticated;
grant execute on function public.space_commit_object(text) to service_role;

revoke all on function public.space_used_bytes(uuid) from public;
revoke all on function public.space_used_bytes(uuid) from anon;
grant execute on function public.space_used_bytes(uuid) to authenticated;
grant execute on function public.space_used_bytes(uuid) to service_role;
